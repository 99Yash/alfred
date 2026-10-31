import {
  assertNever,
  type ClosureSource,
  enumGuard,
  getObjectDef,
  getObjectKindDef,
  isAbsorbingState,
  isObjectStateProvider,
  OBJECT_STATE_CATEGORIES,
  type ObjectIdentity,
  type ObjectStateProvider,
  type StateCategory,
  type JsonObject,
  toRecord,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import {
  type IntegrationObject,
  type IntegrationObjectKey,
  integrationObjectKeys,
  integrationObjectPulls,
  integrationObjects,
} from "@alfred/db/schemas";
import { escapeLike } from "@alfred/db/helpers";
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  type DeliveryInstant,
  deliveryInstantOf,
  deliveryInstantSchema,
  deliveryInstantValue,
} from "./delivery-instant";
import type { ObjectStateEvent } from "./events";
import { reduceGithubEvent } from "./github-reducer";
import { reduceMcpEvent } from "./mcp-reducer";
import { reduceRailwayEvent } from "./railway-reducer";
import { reduceVercelEvent } from "./vercel-reducer";
import { reduceSentryEvent } from "./sentry-reducer";

/**
 * Integration object-state store (ADR-0062). Consumers use {@link ObjectStateStore}, never the
 * tables. Only the per-provider webhook reducers write state, through `applyEvent`.
 */

/** What a provider reducer emits for one webhook delivery. */
export interface ObjectStateDelta {
  kind: string;
  externalId: string;
  /** Native token that the registry's `normalize` maps to a `StateCategory`. */
  nativeState: string;
  /** Verified push or verified pull. No default, so every new producer must name its source. */
  closureSource: ClosureSource;
  /** Provider-clock time. When present it orders the row; else `deliveredAt` does. */
  providerEventTime?: Date | undefined;
  title?: string | undefined;
  url?: string | undefined;
  repo?: string | undefined;
  attributes?: JsonObject | undefined;
  keys: { keyKind: string; keyValue: string }[];
}

export interface ObjectStateRef {
  objectId: string;
  provider: ObjectStateProvider;
  kind: string;
  externalId: string;
}

export interface ObjectState {
  objectId: string;
  provider: ObjectStateProvider;
  kind: string;
  externalId: string;
  stateCategory: StateCategory;
  nativeState: string | null;
  title: string | null;
  url: string | null;
  repo: string | null;
  /** Last delivery that advanced the state, for freshness reports. */
  stateDeliveredAt: Date | null;
}

interface ApplyEventArgs {
  userId: string;
  /** Typed: a stored receipt enters through `parseReceiptEvent`, a pull builds its member. */
  event: ObjectStateEvent;
  /**
   * Receipt time for the recency guard. Not a `Date`: Postgres stores microseconds and `Date` drops
   * them. Read it with `receiptDeliveryInstant()` or `deliveryInstantOf(column)`. Only a pull,
   * which has no row, mints it with `deliveryInstantNow()`.
   */
  deliveredAt: DeliveryInstant;
}

interface ObjectListFilter {
  kind?: string;
  stateCategory?: StateCategory;
  limit?: number;
  /** Inclusive window on `stateDeliveredAt`, e.g. "what resolved today". */
  deliveredWithin?: { start: Date; end: Date };
}

export interface ObjectStateStore {
  applyEvent(args: ApplyEventArgs): Promise<void>;
  resolveByKey(
    userId: string,
    provider: ObjectStateProvider,
    keyKind: string,
    keyValue: string,
  ): Promise<ObjectStateRef | null>;
  /**
   * Batched `resolveByKey`: one query per `(provider, keyKind)`, keyed by `keyValue` (#1087). Empty
   * input skips the database. The keys table is unique per value, so each value maps to one object.
   */
  resolveByKeys(
    userId: string,
    provider: ObjectStateProvider,
    keyKind: string,
    keyValues: readonly string[],
  ): Promise<ReadonlyMap<string, ObjectStateRef>>;
  /**
   * Resolve by a key prefix, e.g. the 7-hex short sha in GitHub Actions mail (#1092). Only
   * registry-declared prefixable key kinds, at their minimum length. Returns `null` on no match or
   * more than one: an ambiguous prefix closes nothing.
   */
  resolveByKeyPrefix(
    userId: string,
    provider: ObjectStateProvider,
    keyKind: string,
    keyPrefix: string,
  ): Promise<ObjectStateRef | null>;
  /**
   * Rows of one kind whose `attributes[attribute]` is one of `values`, with their attributes, for
   * identity containment (ADR-0109). The caller checks the whole tuple and the uniqueness. Empty
   * input skips the database. An abort stops before the next chunk.
   */
  listByIdentityValue(
    userId: string,
    provider: ObjectStateProvider,
    kind: string,
    attribute: string,
    values: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<IdentityCandidateRow[]>;
  /** Current state. `at` is reserved; rows mutate in place, so this is always the live state. */
  getState(userId: string, ref: ObjectStateRef, at?: Date): Promise<ObjectState | null>;
  /** Batched `getState`, keyed by object id. Empty input skips the database. */
  getStates(
    userId: string,
    refs: readonly ObjectStateRef[],
  ): Promise<ReadonlyMap<string, ObjectState>>;
  /** Current state by `(provider, kind, externalId)`, or `null`. */
  getByIdentity(userId: string, identity: ObjectIdentity): Promise<ObjectState | null>;
  list(
    userId: string,
    provider: ObjectStateProvider,
    filter?: ObjectListFilter,
  ): Promise<ObjectState[]>;
  /**
   * Verified pull candidates (#1351): rows never pulled first, then the oldest pull. Among rows
   * never pulled, active rows go first, then the newest. A pull that proves nothing still rotates,
   * so no row holds a slot forever. A row with `demoteAfterAbsentReads` absent reads in a row is
   * left out until a push moves its `updated_at` past its last pull. `null` leaves no row out.
   */
  listPullCandidates(
    userId: string,
    provider: ObjectStateProvider,
    filter: Required<Pick<ObjectListFilter, "kind" | "limit">> & {
      stateCategories: readonly StateCategory[];
      demoteAfterAbsentReads: number | null;
    },
  ): Promise<ObjectState[]>;
  /**
   * Stamp a pull on each object, one millisecond apart in the given order, so the rotation is a
   * strict queue and no batch splits on a tie. A push since the last pick restarts the absent-read
   * count. Empty input skips the database.
   */
  markPulled(userId: string, objectIds: readonly string[], pulledAt: Date): Promise<void>;
  /**
   * Count an absent read on the object's pull stamp, or clear the count after a read that proved a
   * state. A fault records nothing. An object with no pull stamp is left alone.
   */
  recordPullRead(
    userId: string,
    identity: ObjectIdentity,
    read: "absent" | "proved",
  ): Promise<void>;
}

/** `attributes` is the raw jsonb column, so it stays `unknown` until a guard reads it. */
interface IdentityCandidateRow {
  ref: ObjectStateRef;
  attributes: unknown;
}

/** Postgres caps one statement at 65535 parameters. A text can hold many provider links. */
const IDENTITY_VALUE_CHUNK = 1000;

/** The only per-provider code in the store. A provider with no reducer does not compile. */
function reduce(event: ObjectStateEvent): ObjectStateDelta[] {
  switch (event.provider) {
    case "github":
      return reduceGithubEvent(event);
    case "sentry":
      return reduceSentryEvent(event);
    case "railway":
      return reduceRailwayEvent(event);
    case "vercel":
      return reduceVercelEvent(event);
    case "mcp":
      return reduceMcpEvent(event);
    default:
      return assertNever(event, "object-state event provider");
  }
}

const DEFAULT_OBJECT_LIST_LIMIT = 100;

const MAX_OBJECT_LIST_LIMIT = 250;

function clampListLimit(limit: number): number {
  return Math.min(Math.max(1, limit), MAX_OBJECT_LIST_LIMIT);
}

const isStateCategory = enumGuard(OBJECT_STATE_CATEGORIES);

/** Only the typed fold writes these columns, so a value outside the registry is a corrupt row. */
function rowToObjectState(row: IntegrationObject): ObjectState {
  const { provider, stateCategory } = row;

  if (!isObjectStateProvider(provider) || !isStateCategory(stateCategory)) {
    throw new Error(
      `[object-state] row ${row.id} has unknown provider "${provider}" or state category "${stateCategory}"`,
    );
  }

  return {
    objectId: row.id,
    provider,
    kind: row.kind,
    externalId: row.externalId,
    stateCategory,
    nativeState: row.nativeState,
    title: row.title,
    url: row.url,
    repo: row.repo,
    stateDeliveredAt: row.stateDeliveredAt,
  };
}

/** Matches `integration_objects_identity_idx`. Keep the column order aligned with it. */
function objectIdentityWhere(userId: string, identity: ObjectIdentity) {
  return and(
    eq(integrationObjects.userId, userId),
    eq(integrationObjects.provider, identity.provider),
    eq(integrationObjects.kind, identity.kind),
    eq(integrationObjects.externalId, identity.externalId),
  );
}

/**
 * Lock the identity row `FOR NO KEY UPDATE` so the JS recency decision and the write act as one
 * step. A second fold blocks, then sees the committed row. This needs `READ COMMITTED` (the
 * default; no caller sets `isolationLevel`). Under `REPEATABLE READ` the conflict re-read cannot
 * see the row and throws. The guard stays in JS because absorption is the registry's per-kind
 * policy, not SQL. The mode matters for {@link inLockOrder}; the `object-state-row-lock-mode` rule
 * gates it.
 */
function lockIdentityRow(
  tx: DbTransaction,
  userId: string,
  identity: ObjectIdentity,
): Promise<LockedIdentityRow | undefined> {
  return tx
    .select({
      ...getTableColumns(integrationObjects),
      stateDeliveredAtExact: deliveryInstantOf(integrationObjects.stateDeliveredAt),
    })
    .from(integrationObjects)
    .where(objectIdentityWhere(userId, identity))
    .limit(1)
    .for("no key update")
    .then((rows) => rows[0]);
}

/** The locked row plus `state_delivered_at` at microsecond precision, read in the same select. */
type LockedIdentityRow = IntegrationObject & {
  stateDeliveredAtExact: DeliveryInstant | null;
};

/**
 * Code-unit order, not `localeCompare`: collation can rank distinct strings equal and break the
 * lock order.
 */
function compareIdentity(a: ObjectStateDelta, b: ObjectStateDelta): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;

  if (a.externalId === b.externalId) return 0;

  return a.externalId < b.externalId ? -1 : 1;
}

/**
 * Phase 1 lock order: object rows sorted by identity, so two deliveries cannot deadlock (#1203).
 * Phase 2 locks key rows after the loop, in `inKeyLockOrder`. A key upsert takes only
 * `FOR KEY SHARE` on its parent object, which does not conflict with `FOR NO KEY UPDATE`, so no
 * wait crosses phases. `sort` is stable, so two deltas for one identity keep their order and the
 * later one wins. `applyEvent` is the only app writer of either table.
 */
function inLockOrder(deltas: readonly ObjectStateDelta[]): ObjectStateDelta[] {
  return deltas.toSorted(compareIdentity);
}

/** One deferred key upsert, bound to the object its delta resolved. */
type PendingKeyUpsert = Readonly<Pick<IntegrationObjectKey, "keyKind" | "keyValue" | "objectId">>;

/**
 * Code-unit order over `(keyKind, keyValue)`, for the same reason as `compareIdentity`. No
 * `objectId` tie-break: equal keys keep the fold order, so the last folded delta wins the row.
 */
function compareKeyUpsert(a: PendingKeyUpsert, b: PendingKeyUpsert): number {
  if (a.keyKind !== b.keyKind) return a.keyKind < b.keyKind ? -1 : 1;

  if (a.keyValue === b.keyValue) return 0;

  return a.keyValue < b.keyValue ? -1 : 1;
}

/** Phase 2 lock order: the `integration_object_keys` rows of one delivery. */
function inKeyLockOrder(upserts: readonly PendingKeyUpsert[]): PendingKeyUpsert[] {
  return upserts.toSorted(compareKeyUpsert);
}

export const objectStateStore: ObjectStateStore = {
  async applyEvent(args) {
    const { provider } = args.event;
    const deltas = reduce(args.event);

    if (deltas.length === 0) return;

    // The lexical comparison below needs the fixed-width shape, so parse, not trust.
    const deliveredAt = deliveryInstantSchema.parse(args.deliveredAt);

    await db().transaction(async (tx) => {
      // Key upserts lock a second table, so they wait for phase 2.
      const pendingKeys: PendingKeyUpsert[] = [];

      for (const delta of inLockOrder(deltas)) {
        // No kind def means no absorbing policy, so the guard would fail open.
        if (!getObjectKindDef(provider, delta.kind)) continue;

        // An unknown native token is a no-op, never a guessed state.
        const stateCategory = getObjectDef(provider).normalize(delta.kind, delta.nativeState);

        if (!stateCategory) continue;

        const eventTime =
          delta.providerEventTime instanceof Date &&
          !Number.isNaN(delta.providerEventTime.getTime())
            ? delta.providerEventTime
            : null;

        const identity: ObjectIdentity = {
          provider,
          kind: delta.kind,
          externalId: delta.externalId,
        };

        // Null means this transaction creates the row.
        let existing = await lockIdentityRow(tx, args.userId, identity);
        let objectId: string;

        if (!existing) {
          // A missing row cannot be locked, so two first deliveries can both insert.
          // `onConflictDoNothing` makes the loser take the update path instead of failing the job.
          const [row] = await tx
            .insert(integrationObjects)
            .values({
              userId: args.userId,
              provider,
              kind: delta.kind,
              externalId: delta.externalId,
              stateCategory,
              nativeState: delta.nativeState,
              title: delta.title ?? null,
              url: delta.url ?? null,
              repo: delta.repo ?? null,
              attributes: delta.attributes ?? {},
              stateDeliveredAt: deliveryInstantValue(deliveredAt),
              providerEventAt: eventTime,
            })
            .onConflictDoNothing({
              target: [
                integrationObjects.userId,
                integrationObjects.provider,
                integrationObjects.kind,
                integrationObjects.externalId,
              ],
            })
            .returning({ id: integrationObjects.id });

          if (row) {
            objectId = row.id;
          } else {
            // Another transaction committed this identity first. Lock it and go through the guard.
            existing = await lockIdentityRow(tx, args.userId, identity);

            if (!existing) {
              throw new Error("[object-state] applyEvent conflicted with a row it cannot read");
            }

            objectId = existing.id;
          }
        } else {
          objectId = existing.id;
        }

        if (existing) {
          // Recency: provider clock first, then receipt clock at microsecond precision (#1093,
          // #1200). A null provider time on the row yields to a timestamped delta. `>=`, not `>`: a
          // retried fold of the same receipt must re-apply, so the fold stays idempotent.
          const existingDelivered =
            existing.stateDeliveredAtExact === null
              ? null
              : deliveryInstantSchema.parse(existing.stateDeliveredAtExact);

          const isNewer =
            eventTime === null
              ? existingDelivered === null || deliveredAt >= existingDelivered
              : existing.providerEventAt === null ||
                eventTime.getTime() > existing.providerEventAt.getTime() ||
                (eventTime.getTime() === existing.providerEventAt.getTime() &&
                  (existingDelivered === null || deliveredAt >= existingDelivered));

          // The kind declares which states are final. CI runs and deploys declare none (#1093).
          const wouldLeaveAbsorbingState =
            stateCategory !== existing.stateCategory &&
            isAbsorbingState(provider, delta.kind, existing.stateCategory);

          if (isNewer && !wouldLeaveAbsorbingState) {
            await tx
              .update(integrationObjects)
              .set({
                stateCategory,
                nativeState: delta.nativeState,
                title: delta.title ?? existing.title,
                url: delta.url ?? existing.url,
                repo: delta.repo ?? existing.repo,
                attributes: { ...toRecord(existing.attributes), ...delta.attributes },
                stateDeliveredAt: deliveryInstantValue(deliveredAt),
                ...(eventTime === null ? {} : { providerEventAt: eventTime }),
              })
              .where(eq(integrationObjects.id, objectId));
          }
        }

        // Keys are additive identity facts, so they upsert regardless of event order.
        for (const key of delta.keys) {
          pendingKeys.push({ keyKind: key.keyKind, keyValue: key.keyValue, objectId });
        }
      }

      // Phase 2. Nothing in the loop reads keys; code that resolves by key there must also read
      // `pendingKeys`.
      for (const pending of inKeyLockOrder(pendingKeys)) {
        await tx
          .insert(integrationObjectKeys)
          .values({
            userId: args.userId,
            objectId: pending.objectId,
            provider,
            keyKind: pending.keyKind,
            keyValue: pending.keyValue,
          })
          .onConflictDoUpdate({
            target: [
              integrationObjectKeys.userId,
              integrationObjectKeys.provider,
              integrationObjectKeys.keyKind,
              integrationObjectKeys.keyValue,
            ],
            set: { objectId: pending.objectId },
          });
      }
    });
  },

  async resolveByKey(userId, provider, keyKind, keyValue) {
    const [row] = await db()
      .select({
        objectId: integrationObjectKeys.objectId,
        kind: integrationObjects.kind,
        externalId: integrationObjects.externalId,
      })
      .from(integrationObjectKeys)
      .innerJoin(integrationObjects, eq(integrationObjectKeys.objectId, integrationObjects.id))
      .where(
        and(
          eq(integrationObjectKeys.userId, userId),
          eq(integrationObjectKeys.provider, provider),
          eq(integrationObjectKeys.keyKind, keyKind),
          eq(integrationObjectKeys.keyValue, keyValue),
        ),
      )
      .limit(1);

    if (!row) return null;

    return { objectId: row.objectId, provider, kind: row.kind, externalId: row.externalId };
  },

  async resolveByKeys(userId, provider, keyKind, keyValues) {
    if (keyValues.length === 0) return new Map();

    const rows = await db()
      .select({
        keyValue: integrationObjectKeys.keyValue,
        objectId: integrationObjectKeys.objectId,
        kind: integrationObjects.kind,
        externalId: integrationObjects.externalId,
      })
      .from(integrationObjectKeys)
      .innerJoin(integrationObjects, eq(integrationObjectKeys.objectId, integrationObjects.id))
      .where(
        and(
          eq(integrationObjectKeys.userId, userId),
          eq(integrationObjectKeys.provider, provider),
          eq(integrationObjectKeys.keyKind, keyKind),
          inArray(integrationObjectKeys.keyValue, [...keyValues]),
        ),
      );

    const byKeyValue = new Map<string, ObjectStateRef>();

    for (const row of rows) {
      byKeyValue.set(row.keyValue, {
        objectId: row.objectId,
        provider,
        kind: row.kind,
        externalId: row.externalId,
      });
    }

    return byKeyValue;
  },

  async listByIdentityValue(userId, provider, kind, attribute, values, abortSignal) {
    const rows: IdentityCandidateRow[] = [];

    for (let start = 0; start < values.length; start += IDENTITY_VALUE_CHUNK) {
      abortSignal?.throwIfAborted();
      const chunk = values.slice(start, start + IDENTITY_VALUE_CHUNK);

      const found = await db()
        .select({
          objectId: integrationObjects.id,
          externalId: integrationObjects.externalId,
          attributes: integrationObjects.attributes,
        })
        .from(integrationObjects)
        .where(
          and(
            eq(integrationObjects.userId, userId),
            eq(integrationObjects.provider, provider),
            eq(integrationObjects.kind, kind),
            inArray(sql<string>`${integrationObjects.attributes} ->> ${attribute}`, chunk),
          ),
        );

      for (const row of found) {
        rows.push({
          ref: { objectId: row.objectId, provider, kind, externalId: row.externalId },
          attributes: row.attributes,
        });
      }
    }

    return rows;
  },

  async resolveByKeyPrefix(userId, provider, keyKind, keyPrefix) {
    // The registry declares prefixable keys. Else a prefix like `"https:/"` would match every PR
    // URL.
    const minPrefixLength = getObjectDef(provider).prefixableKeys[keyKind];

    if (minPrefixLength === undefined || keyPrefix.length < minPrefixLength) return null;

    // `LIKE 'x%'` cannot use the btree under a non-C collation, so add a range the index can
    // answer. Hex orders the same in en_US.utf8 and C, so `[prefix, nextPrefix)` equals the LIKE
    // match.
    const nextPrefix =
      keyPrefix.slice(0, -1) + String.fromCharCode(keyPrefix.charCodeAt(keyPrefix.length - 1) + 1);

    const rows = await db()
      .selectDistinct({
        objectId: integrationObjectKeys.objectId,
        kind: integrationObjects.kind,
        externalId: integrationObjects.externalId,
      })
      .from(integrationObjectKeys)
      .innerJoin(integrationObjects, eq(integrationObjectKeys.objectId, integrationObjects.id))
      .where(
        and(
          eq(integrationObjectKeys.userId, userId),
          eq(integrationObjectKeys.provider, provider),
          eq(integrationObjectKeys.keyKind, keyKind),
          gte(integrationObjectKeys.keyValue, keyPrefix),
          lt(integrationObjectKeys.keyValue, nextPrefix),
          like(integrationObjectKeys.keyValue, `${escapeLike(keyPrefix)}%`),
        ),
      )
      // Two rows already prove ambiguity.
      .limit(2);

    const [row, second] = rows;

    if (!row || second) return null;

    return { objectId: row.objectId, provider, kind: row.kind, externalId: row.externalId };
  },

  async getState(userId, ref) {
    const [row] = await db()
      .select()
      .from(integrationObjects)
      .where(and(eq(integrationObjects.id, ref.objectId), eq(integrationObjects.userId, userId)))
      .limit(1);

    if (!row) return null;

    return rowToObjectState(row);
  },

  async getStates(userId, refs) {
    const objectIds = [...new Set(refs.map((ref) => ref.objectId))];

    if (objectIds.length === 0) return new Map();

    const rows = await db()
      .select()
      .from(integrationObjects)
      .where(and(eq(integrationObjects.userId, userId), inArray(integrationObjects.id, objectIds)));

    const byObjectId = new Map<string, ObjectState>();

    for (const row of rows) {
      byObjectId.set(row.id, rowToObjectState(row));
    }

    return byObjectId;
  },

  async getByIdentity(userId, identity) {
    const [row] = await db()
      .select()
      .from(integrationObjects)
      .where(objectIdentityWhere(userId, identity))
      .limit(1);

    if (!row) return null;

    return rowToObjectState(row);
  },

  async list(userId, provider, filter) {
    const conditions = [
      eq(integrationObjects.userId, userId),
      eq(integrationObjects.provider, provider),
    ];

    if (filter?.kind) conditions.push(eq(integrationObjects.kind, filter.kind));

    if (filter?.stateCategory) {
      conditions.push(eq(integrationObjects.stateCategory, filter.stateCategory));
    }

    if (filter?.deliveredWithin) {
      conditions.push(
        gte(integrationObjects.stateDeliveredAt, filter.deliveredWithin.start),
        lte(integrationObjects.stateDeliveredAt, filter.deliveredWithin.end),
      );
    }

    const requestedLimit = filter?.limit ?? DEFAULT_OBJECT_LIST_LIMIT;
    const limit = clampListLimit(requestedLimit);

    // In a window, order by resolve time, so the limit keeps fresh resolves over later
    // re-projections.
    const order = filter?.deliveredWithin
      ? [desc(integrationObjects.stateDeliveredAt), desc(integrationObjects.updatedAt)]
      : [desc(integrationObjects.updatedAt)];

    const rows = await db()
      .select()
      .from(integrationObjects)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(limit);

    return rows.map(rowToObjectState);
  },

  async listPullCandidates(userId, provider, filter) {
    if (filter.stateCategories.length === 0) return [];

    const limit = clampListLimit(filter.limit);

    const rows = await db()
      .select(getTableColumns(integrationObjects))
      .from(integrationObjects)
      .leftJoin(integrationObjectPulls, eq(integrationObjectPulls.objectId, integrationObjects.id))
      .where(
        and(
          eq(integrationObjects.userId, userId),
          eq(integrationObjects.provider, provider),
          eq(integrationObjects.kind, filter.kind),
          inArray(integrationObjects.stateCategory, [...filter.stateCategories]),
          // A push since the last pull puts a demoted row back; `markPulled` restarts its count.
          filter.demoteAfterAbsentReads === null
            ? undefined
            : or(
                isNull(integrationObjectPulls.objectId),
                lt(integrationObjectPulls.absentReads, filter.demoteAfterAbsentReads),
                gt(integrationObjects.updatedAt, integrationObjectPulls.pulledAt),
              ),
        ),
      )
      .orderBy(
        sql`${integrationObjectPulls.pulledAt} asc nulls first`,
        sql`${integrationObjects.stateCategory} = ${"active" satisfies StateCategory} desc`,
        desc(integrationObjects.updatedAt),
      )
      .limit(limit);

    return rows.map(rowToObjectState);
  },

  async markPulled(userId, objectIds, pulledAt) {
    if (objectIds.length === 0) return;

    await db()
      .insert(integrationObjectPulls)
      .values(
        objectIds.map((objectId, index) => ({
          userId,
          objectId,
          pulledAt: new Date(pulledAt.getTime() + index),
        })),
      )
      .onConflictDoUpdate({
        target: integrationObjectPulls.objectId,
        set: {
          pulledAt: sql`excluded.pulled_at`,
          // The same push rule that puts a demoted row back in `listPullCandidates`.
          absentReads: sql`case when (
            select ${integrationObjects.updatedAt} from ${integrationObjects}
            where ${integrationObjects.id} = excluded.object_id
          ) > ${integrationObjectPulls.pulledAt} then 0 else ${integrationObjectPulls.absentReads} end`,
        },
      });
  },

  async recordPullRead(userId, identity, read) {
    const object = db()
      .select({ id: integrationObjects.id })
      .from(integrationObjects)
      .where(objectIdentityWhere(userId, identity));

    await db()
      .update(integrationObjectPulls)
      .set({
        absentReads: read === "absent" ? sql`${integrationObjectPulls.absentReads} + 1` : 0,
      })
      .where(
        and(
          eq(integrationObjectPulls.userId, userId),
          inArray(integrationObjectPulls.objectId, object),
          ...(read === "proved" ? [gt(integrationObjectPulls.absentReads, 0)] : []),
        ),
      );
  },
};
