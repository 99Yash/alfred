import {
  getObjectDef,
  getObjectKindDef,
  isAbsorbingState,
  type ObjectIdentity,
  type ObjectStateProvider,
  type StateCategory,
  toRecord,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  type IntegrationObject,
  integrationObjectKeys,
  integrationObjects,
} from "@alfred/db/schemas";
import { escapeLike } from "@alfred/db/helpers";
import { and, desc, eq, gte, like, lt, lte } from "drizzle-orm";
import { reduceGithubEvent } from "./github-reducer";
import { reduceSentryEvent } from "./sentry-reducer";

/**
 * Integration object-state store (ADR-0062, #212) — the ADR-0058 swappable
 * abstraction over the `integration_objects` / `_keys` / `_relations` tables.
 * Consumers depend on {@link ObjectStateStore}, never the tables, so the store
 * can be reimplemented without touching the briefing reconciliation or the
 * webhook reducer wiring.
 *
 * State is asserted ONLY here, from the deterministic per-provider reducer over
 * webhook payloads (propose/dispose). `resolveByKey`/`getState` are the read
 * path the briefing loop-closure uses: an email's `head_sha` or canonical PR
 * URL → PR ref → terminal state.
 */

/** The projection delta a per-provider reducer emits for one webhook delivery. */
export interface ObjectStateDelta {
  kind: string;
  externalId: string;
  /** Native-state token the registry's `normalize` maps to a `StateCategory`. */
  nativeState: string;
  /**
   * Provider-clock instant for this delta (a suite's `updated_at`). A delta
   * that carries one orders its row by provider event time; a delta without
   * one (every PR delta, every attempt row) keeps the receipt-clock guard.
   * Absent or invalid at the reducer means absent here — never a smuggled
   * null — and the store falls back to `deliveredAt` for the ordering.
   */
  providerEventTime?: Date | undefined;
  title?: string | undefined;
  url?: string | undefined;
  repo?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
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
  /**
   * Last delivery that advanced this object's state. Exposed so a reader can
   * report when the projection observed the state (freshness) instead of
   * inferring it from absence; the briefing reconciliation ignores it.
   */
  stateDeliveredAt: Date | null;
}

export interface ApplyEventArgs {
  userId: string;
  provider: ObjectStateProvider;
  eventType: string;
  action: string | null;
  payload: unknown;
  /** When this delivery was received — guards monotonic state transitions. */
  deliveredAt: Date;
}

export interface ObjectListFilter {
  kind?: string;
  stateCategory?: StateCategory;
  limit?: number;
  /**
   * Restrict to objects whose current state was delivered within `[start, end]`
   * (inclusive), keyed on `stateDeliveredAt`. For `stateCategory: "resolved"`
   * this windows "what resolved in this period" — e.g. the evening briefing's
   * "what shipped today" recap, so a stale or future-resolved object can't leak
   * into the window on a retry.
   */
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
   * Same lookup for an ABBREVIATED key: the stored key must START WITH
   * `keyPrefix`. GitHub Actions failure mail names the run's commit in the
   * 7-hex short form, so the exact lookup can never find it (#1092).
   *
   * Only key kinds the registry declares prefixable (with their minimum
   * length) support this; any other `keyKind` returns `null`. Returns `null`
   * when the prefix matches no object AND when it matches more than one — an
   * ambiguous prefix is not an identity, so it may close nothing. A prefix
   * shorter than the declared floor is rejected outright.
   */
  resolveByKeyPrefix(
    userId: string,
    provider: ObjectStateProvider,
    keyKind: string,
    keyPrefix: string,
  ): Promise<ObjectStateRef | null>;
  /**
   * Current state for a ref. `at` is reserved for point-in-time reads once
   * supersession rows are written (a fast-follow); v1 mutates a single row in
   * place, so it always returns the live state.
   */
  getState(userId: string, ref: ObjectStateRef, at?: Date): Promise<ObjectState | null>;
  /**
   * Current state by provider-native identity, the `(provider, kind,
   * externalId)` unique key indexed by `integration_objects_identity_idx`. The
   * deterministic read for a caller that already knows the object, not its
   * sidecar key; returns `null` when no row exists.
   */
  getByIdentity(userId: string, identity: ObjectIdentity): Promise<ObjectState | null>;
  list(
    userId: string,
    provider: ObjectStateProvider,
    filter?: ObjectListFilter,
  ): Promise<ObjectState[]>;
}

type ReduceFn = (eventType: string, action: string | null, payload: unknown) => ObjectStateDelta[];

/** Per-provider reducers. The only per-provider code; everything else is generic. */
const REDUCERS = {
  github: reduceGithubEvent,
  sentry: reduceSentryEvent,
} satisfies Record<ObjectStateProvider, ReduceFn>;

const DEFAULT_OBJECT_LIST_LIMIT = 100;

const MAX_OBJECT_LIST_LIMIT = 250;

function rowToObjectState(row: IntegrationObject): ObjectState {
  return {
    objectId: row.id,
    // SAFETY: object_state.provider is a text column written only with
    // registry-known provider ids; this read views it as that union.
    provider: row.provider as ObjectStateProvider,
    kind: row.kind,
    externalId: row.externalId,
    // Legal values are guaranteed on the write path by the registry.
    // SAFETY: that write-path guarantee is exactly what this read asserts.
    stateCategory: row.stateCategory as StateCategory,
    nativeState: row.nativeState,
    title: row.title,
    url: row.url,
    repo: row.repo,
    stateDeliveredAt: row.stateDeliveredAt,
  };
}

/**
 * The `(userId, provider, kind, externalId)` unique-key predicate, shared by the
 * `applyEvent` upsert lookup and `getByIdentity` so the two cannot drift. It
 * matches `integration_objects_identity_idx`; keep the column order aligned with
 * that index.
 */
function objectIdentityWhere(userId: string, identity: ObjectIdentity) {
  return and(
    eq(integrationObjects.userId, userId),
    eq(integrationObjects.provider, identity.provider),
    eq(integrationObjects.kind, identity.kind),
    eq(integrationObjects.externalId, identity.externalId),
  );
}

export const objectStateStore: ObjectStateStore = {
  async applyEvent(args) {
    const reduce = REDUCERS[args.provider];
    const deltas = reduce(args.eventType, args.action, args.payload);

    if (deltas.length === 0) return;

    await db().transaction(async (tx) => {
      for (const delta of deltas) {
        // Unknown kinds never write: without a kind def there is no absorbing
        // policy, so the monotonicity guard below would fail open and let a later
        // delivery regress a resolved row back to active.
        if (!getObjectKindDef(args.provider, delta.kind)) continue;

        // Native → agnostic bucket. An unrecognized token is a no-op, never a
        // guessed state (absence never closes).
        const stateCategory = getObjectDef(args.provider).normalize(delta.kind, delta.nativeState);

        if (!stateCategory) continue;

        // The provider-clock instant this delta speaks for: the reducer's own
        // timestamp when valid, else the receipt clock. Attempt rows never
        // carry one and keep the deliveredAt-only guard below.
        const eventTime =
          delta.providerEventTime instanceof Date &&
          !Number.isNaN(delta.providerEventTime.getTime())
            ? delta.providerEventTime
            : null;

        const [existing] = await tx
          .select()
          .from(integrationObjects)
          .where(
            objectIdentityWhere(args.userId, {
              provider: args.provider,
              kind: delta.kind,
              externalId: delta.externalId,
            }),
          )
          .limit(1);

        let objectId: string;

        if (!existing) {
          const [row] = await tx
            .insert(integrationObjects)
            .values({
              userId: args.userId,
              provider: args.provider,
              kind: delta.kind,
              externalId: delta.externalId,
              stateCategory,
              nativeState: delta.nativeState,
              title: delta.title ?? null,
              url: delta.url ?? null,
              repo: delta.repo ?? null,
              attributes: delta.attributes ?? {},
              stateDeliveredAt: args.deliveredAt,
              providerEventAt: eventTime,
            })
            .returning({ id: integrationObjects.id });

          if (!row) throw new Error("[object-state] applyEvent insert returned no row");
          objectId = row.id;
        } else {
          objectId = existing.id;

          // Recency is the provider clock first, the receipt clock second: the
          // row holds the outcome of the attempt with the greatest
          // (providerEventTime, deliveredAt) pair (#1093). A row that predates
          // provider-time tracking (null) always yields to a timestamped
          // delta; a delta without a timestamp falls back to the deliveredAt
          // guard the PR rows always used.
          const isNewer =
            eventTime === null
              ? existing.stateDeliveredAt === null || args.deliveredAt >= existing.stateDeliveredAt
              : existing.providerEventAt === null ||
                eventTime.getTime() > existing.providerEventAt.getTime() ||
                (eventTime.getTime() === existing.providerEventAt.getTime() &&
                  (existing.stateDeliveredAt === null ||
                    args.deliveredAt >= existing.stateDeliveredAt));

          // Which states are final is the KIND's declaration, not this file's
          // rule. Work that closes by succession rather than by transition — a CI
          // run, a deployment — declares no absorbing state at all, and then a
          // later failure after a success lands here as ordinary traffic (#1093).
          const wouldLeaveAbsorbingState =
            stateCategory !== existing.stateCategory &&
            isAbsorbingState(args.provider, delta.kind, existing.stateCategory);

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
                stateDeliveredAt: args.deliveredAt,
                ...(eventTime === null ? {} : { providerEventAt: eventTime }),
              })
              .where(eq(integrationObjects.id, objectId));
          }
        }

        // Keys are additive identity facts about the object — upsert regardless
        // of event order (the same head_sha always maps to the same PR).
        for (const key of delta.keys) {
          await tx
            .insert(integrationObjectKeys)
            .values({
              userId: args.userId,
              objectId,
              provider: args.provider,
              keyKind: key.keyKind,
              keyValue: key.keyValue,
            })
            .onConflictDoUpdate({
              target: [
                integrationObjectKeys.userId,
                integrationObjectKeys.provider,
                integrationObjectKeys.keyKind,
                integrationObjectKeys.keyValue,
              ],
              set: { objectId },
            });
        }
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

  async resolveByKeyPrefix(userId, provider, keyKind, keyPrefix) {
    // Prefix semantics are the registry's per-provider declaration
    // (`prefixableKeys` beside the closure policy), not this file's rule: a
    // second provider declares its own prefixable key kinds without touching
    // the store. A short non-sha prefix such as `"https:/"` would otherwise
    // clear the length floor and match every stored PR URL of its kind.
    const minPrefixLength = getObjectDef(provider).prefixableKeys[keyKind];

    if (minPrefixLength === undefined || keyPrefix.length < minPrefixLength) return null;

    // `LIKE 'prefix%'` alone cannot use the btree under a non-C collation —
    // the equality columns select every head_sha row, so the filter scans the
    // table. The range beside it is what the index answers (LIKE stays as the
    // residual filter): prefix values are [0-9a-f], which en_US.utf8 orders
    // like C, so [prefix, nextPrefix) holds exactly the rows LIKE matches.
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
      // Two rows is already proof of ambiguity; the third would tell us nothing
      // more. Several keys of one object collapse in the DISTINCT.
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
    const limit = Math.min(Math.max(1, requestedLimit), MAX_OBJECT_LIST_LIMIT);

    // When windowing on delivery time, the selected set must be the most recently
    // *resolved* objects (the event that delivered the state), not the most
    // recently rewritten projections — `updatedAt` only tie-breaks. Otherwise the
    // limit can drop a freshly-resolved object in favour of an older one that was
    // merely re-projected later (#210 day-shape "what you shipped").
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
};
