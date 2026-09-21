import {
  type ClosureSource,
  getObjectDef,
  getObjectKindDef,
  isAbsorbingState,
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
  integrationObjects,
} from "@alfred/db/schemas";
import { escapeLike } from "@alfred/db/helpers";
import { and, desc, eq, getTableColumns, gte, inArray, like, lt, lte } from "drizzle-orm";
import {
  type DeliveryInstant,
  deliveryInstantOf,
  deliveryInstantSchema,
  deliveryInstantValue,
} from "./delivery-instant";
import { reduceGithubEvent } from "./github-reducer";
import { reduceRailwayEvent } from "./railway-reducer";
import { reduceVercelEvent } from "./vercel-reducer";
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
   * How this delta knows what it asserts: a verified push receipt, or a
   * verified pull (an authenticated read of current state). Required with no
   * default, so a new producer cannot silently inherit one — the declaration
   * is the tier-3 proof every assertion path names its source. The store
   * never branches on it; closure policy stays per-kind in `closesOpenAsk`.
   */
  closureSource: ClosureSource;
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
  /**
   * When this delivery was received — guards monotonic state transitions.
   *
   * A {@link DeliveryInstant}, not a `Date`: the guard compares this against
   * the stored instant, and a `Date` holds only milliseconds while Postgres
   * records `delivered_at` to the microsecond. Mint it with
   * `receiptDeliveryInstant()` when a receipt row exists, or
   * `deliveryInstantFromDate()` when the caller has only a JavaScript clock.
   */
  deliveredAt: DeliveryInstant;
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
   * The batched exact lookup: every stored key in one `inArray` over
   * `keyValue`, keyed back by `keyValue`. One call per `(provider, keyKind)`
   * group replaces one `resolveByKey` call per candidate key, so a read that
   * proposes hundreds of keys costs one round trip per group instead of one
   * per key against the pool (#1087). An empty `keyValues` resolves to an
   * empty map without touching the database (`inArray([])` is degenerate).
   *
   * The batch returns the same row the per-key `.limit(1)` returns: the keys
   * table holds a uniqueness on `(userId, provider, keyKind, keyValue)`, so at
   * most one keys row matches per value and the join fans out to exactly one
   * object row.
   */
  resolveByKeys(
    userId: string,
    provider: ObjectStateProvider,
    keyKind: string,
    keyValues: readonly string[],
  ): Promise<ReadonlyMap<string, ObjectStateRef>>;
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
   * The batched state read: one `inArray` over the object ids, keyed back by
   * object id. The companion to `resolveByKeys` — the resolve's second query
   * per candidate collapses into this one call. An empty `refs` resolves to
   * an empty map without touching the database.
   */
  getStates(
    userId: string,
    refs: readonly ObjectStateRef[],
  ): Promise<ReadonlyMap<string, ObjectState>>;
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
  railway: reduceRailwayEvent,
  vercel: reduceVercelEvent,
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

/**
 * Read the identity row and hold it `FOR NO KEY UPDATE` until the transaction
 * ends.
 *
 * `applyEvent` decides recency and absorption in JavaScript, then writes. The
 * lock is what makes the decision and the write one step: a second fold of the
 * same target blocks here, and under `READ COMMITTED` Postgres hands it the row
 * version the first fold committed, so it guards against the NEW state rather
 * than the stale one it would otherwise have read.
 *
 * `READ COMMITTED` is a real precondition, and it holds because no caller sets
 * an isolation level — the repo passes `isolationLevel` nowhere, so every
 * transaction takes the Postgres default. Raise this path to `REPEATABLE READ`
 * and the conflict branch below breaks: the re-read cannot see a row committed
 * after the transaction's snapshot, so it throws instead of folding.
 *
 * The predicate could instead move into the `UPDATE`'s `WHERE`, which would
 * close the recency half alone. It cannot close the absorption half:
 * `isAbsorbingState` is the KIND's declaration, read from the registry, and
 * spelling it in SQL would move that policy out of the registry and into this
 * file — the thing the guard's own comment forbids.
 *
 * The lock MODE is load-bearing for the two-phase order in {@link inLockOrder},
 * which states why. The `object-state-row-lock-mode` rule in
 * `scripts/consolidation-rules.mjs` gates it, so this comment does not have to.
 *
 * What the mode gives up is nothing this path uses. Postgres counts a column as
 * a KEY column when it belongs to ANY immediate unique index, not only the
 * primary key, so the key columns here are `id` PLUS
 * `(user_id, provider, kind, external_id)` from
 * `integration_objects_identity_idx`. `applyEvent`'s `UPDATE` sets
 * `state_category`, `native_state`, `title`, `url`, `repo`, `attributes`,
 * `state_delivered_at` and `provider_event_at`, and nothing else — no key
 * column of either index. The weaker mode still conflicts with `FOR UPDATE`,
 * `FOR NO KEY UPDATE`, `UPDATE` and `DELETE`, so two concurrent folds of one
 * target still exclude each other, which is what this lock exists for.
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

/**
 * The locked row, plus `state_delivered_at` at full precision.
 *
 * The extra field is a computed column on the SAME select, not a second read:
 * `applyEvent` is two-phase (#1203) and nothing may read between the phases, so
 * the incumbent instant has to ride along with the lock that already exists.
 * The `Date` column stays for the read path, which reports freshness and needs
 * no microseconds.
 */
type LockedIdentityRow = IntegrationObject & {
  stateDeliveredAtExact: DeliveryInstant | null;
};

/**
 * Code-unit order over the two identity fields that vary within one delivery.
 *
 * NOT `localeCompare`: collation ranks some DISTINCT strings equal (`"é"`
 * against `"é"` returns 0), and a comparator that returns 0 for two different
 * targets lets two transactions keep them in opposite emitted orders — the very
 * thing `inLockOrder` exists to stop. `<`/`>` is a strict total order over
 * strings, and it is what `lockChatStorageKeys` already sorts by.
 */
function compareIdentity(a: ObjectStateDelta, b: ObjectStateDelta): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;

  if (a.externalId === b.externalId) return 0;

  return a.externalId < b.externalId ? -1 : 1;
}

/**
 * Stable lock order for the `integration_objects` rows of one delivery.
 *
 * `applyEvent` now takes a row lock per delta, so two transactions that touch
 * the same two targets in opposite orders would deadlock. Ordering by the
 * identity tuple removes that for these rows: the two agree on who waits.
 * `provider` and `userId` are constant across one call, so `kind` and
 * `externalId` decide the whole order. `sort` is stable, so two deltas for ONE
 * identity keep their emitted order and the later one still wins.
 *
 * This is phase 1 of two, and the pair is deadlock-free over BOTH tables
 * (#1203). `applyEvent` takes every `integration_objects` row lock of a
 * delivery here, then every `integration_object_keys` row lock after the loop,
 * in `inKeyLockOrder`.
 *
 * A transaction that waits on a key row has finished phase 1, so it waits on no
 * object. It still HOLDS objects, plus every key row phase 2 already inserted;
 * only the "waits on no object" half carries the proof, and that half is a fact
 * about the lock MODE, not about this loop: the foreign key on
 * `integration_object_keys.object_id` makes every phase-2 upsert take
 * `FOR KEY SHARE` on its parent object row, and `FOR KEY SHARE` does not
 * conflict with the `FOR NO KEY UPDATE` {@link lockIdentityRow} holds, so that
 * check never waits. A transaction that waits on an object row is still in
 * phase 1, so it holds no key. A wait-for cycle therefore lies inside one
 * phase, and each phase is ordered, so no cycle exists.
 *
 * The guarantee is over the application write path, and `applyEvent` is that
 * path's only writer of either table. The pair is the whole list because
 * `integration_objects`' only OTHER foreign-key child,
 * `integration_object_relations.object_id`, has no writer anywhere in the tree.
 * Its object edge stays closed under this mode for the same `FOR KEY SHARE`
 * reason, but a transaction that writes a relation AND an object needs a phase
 * of its own here before it exists.
 *
 * Two writers sit outside `applyEvent`: migration `0131_violet_elektra.sql`,
 * which bulk-inserted key rows once in scan order, and the `user`
 * `ON DELETE CASCADE`, whose row deletes do conflict with `FOR KEY SHARE`.
 * Neither runs beside a delivery — 0131 has run, and the cascade fires only
 * when the account itself goes away.
 */
function inLockOrder(deltas: readonly ObjectStateDelta[]): ObjectStateDelta[] {
  return [...deltas].sort(compareIdentity);
}

/**
 * One deferred key upsert, bound to the object its delta resolved.
 *
 * Derived from the table's row type rather than redeclared, so a later
 * `.$type<>()` on `key_kind` narrows this with it.
 */
type PendingKeyUpsert = Readonly<Pick<IntegrationObjectKey, "keyKind" | "keyValue" | "objectId">>;

/**
 * Code-unit order over `(keyKind, keyValue)`, for the same reason
 * `compareIdentity` is: `localeCompare` ranks some DISTINCT strings equal, so a
 * sort built on it is not a strict total order and two transactions can keep
 * two key rows in opposite order — which is the cycle this order removes.
 *
 * `objectId` is deliberately NOT a tie-break. Two deltas that carry one key
 * value for two different objects must fall through to the stable `sort` and
 * keep the order the fold loop pushed them in — which is `inLockOrder`'s lock
 * order, not the reducer's emitted order — so the delta folded last still wins
 * the row, exactly as it did before the deferral.
 */
function compareKeyUpsert(a: PendingKeyUpsert, b: PendingKeyUpsert): number {
  if (a.keyKind !== b.keyKind) return a.keyKind < b.keyKind ? -1 : 1;

  if (a.keyValue === b.keyValue) return 0;

  return a.keyValue < b.keyValue ? -1 : 1;
}

/** Phase 2 of the lock order: the `integration_object_keys` rows of one delivery. */
function inKeyLockOrder(upserts: readonly PendingKeyUpsert[]): PendingKeyUpsert[] {
  return [...upserts].sort(compareKeyUpsert);
}

export const objectStateStore: ObjectStateStore = {
  async applyEvent(args) {
    const reduce = REDUCERS[args.provider];
    const deltas = reduce(args.eventType, args.action, args.payload);

    if (deltas.length === 0) return;

    // The brand says the caller used a constructor; this says the value still
    // holds the fixed-width shape the lexical comparison below depends on. The
    // instant reaches most callers out of the database, so the owning boundary
    // parses it rather than trusting the select's result type.
    const deliveredAt = deliveryInstantSchema.parse(args.deliveredAt);

    await db().transaction(async (tx) => {
      // Phase 2's work, collected during phase 1. A key upsert takes a row lock
      // on a SECOND table, so issuing it inside the loop would interleave key
      // locks between object locks and reopen the ABBA cycle `inLockOrder`
      // closes.
      const pendingKeys: PendingKeyUpsert[] = [];

      for (const delta of inLockOrder(deltas)) {
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

        const identity: ObjectIdentity = {
          provider: args.provider,
          kind: delta.kind,
          externalId: delta.externalId,
        };

        // The row this delta must not regress. Null means THIS transaction
        // created it, so there is no prior state to guard.
        let existing = await lockIdentityRow(tx, args.userId, identity);
        let objectId: string;

        if (!existing) {
          // `onConflictDoNothing`, not a bare insert. A row that does not exist
          // yet cannot be locked, so two first deliveries for one target both
          // read nothing and both insert; `integration_objects_identity_idx` is
          // UNIQUE, so the loser used to raise `23505` and abort. The fold
          // consumer runs `mode: "propagate"`, so that abort failed the whole
          // `ingress.deliver` job. Absorbing the conflict turns the loser into
          // the ordinary update path below.
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
            // The conflict fired: another transaction inserted this identity
            // after the lock read found nothing, and has since committed —
            // `onConflictDoNothing` waited for it. Take the lock now and fold
            // through the guard, so this delivery cannot overwrite the state
            // the winner just wrote.
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
          // Recency is the provider clock first, the receipt clock second: the
          // row holds the outcome of the attempt with the greatest
          // (providerEventTime, deliveredAt) pair (#1093) — given each
          // receipt is successfully folded exactly once, with the
          // no-byte-identical-repeat and every-receipt-folds preconditions
          // item 03 hardened. The serial-fold precondition is no longer
          // assumed: the `FOR NO KEY UPDATE` above enforces it, so `existing` is the
          // state a concurrent fold committed, not the state this transaction
          // read before it. Neither is a 1 ms separation: both sides of the
          // receipt-clock comparison are `DeliveryInstant`s read at the
          // microsecond resolution Postgres stores (#1200), so two deliveries
          // 444 µs apart resolve in true delivery order rather than commit
          // order. A row that predates provider-time tracking (null) always
          // yields to a timestamped delta; a delta without a timestamp falls
          // back to the deliveredAt guard the PR rows always used.
          //
          // `>=`, not `>`: a retried fold of one receipt carries the identical
          // instant and must still re-apply, which is what keeps `applyEvent`
          // idempotent. That is why one precondition replaces the 1 ms one:
          // two DISTINCT deliveries that share a single `delivered_at`
          // microsecond are still last-writer-wins. `providerEventTime`, the
          // dominant term, is also still a millisecond `Date` (#1200 made only
          // the tie-break term exact).
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
                stateDeliveredAt: deliveryInstantValue(deliveredAt),
                ...(eventTime === null ? {} : { providerEventAt: eventTime }),
              })
              .where(eq(integrationObjects.id, objectId));
          }
        }

        // Keys are additive identity facts about the object — upsert regardless
        // of event order (the same head_sha always maps to the same PR). The
        // write itself waits for phase 2; `objectId` rides along, because the
        // deferred row must still name the object THIS delta resolved.
        for (const key of delta.keys) {
          pendingKeys.push({ keyKind: key.keyKind, keyValue: key.keyValue, objectId });
        }
      }

      // Phase 2: every key row of the delivery, after every object row, in its
      // own order. `sort` is stable, so two deltas that carry one key value for
      // two objects keep the order the loop pushed them in — `inLockOrder`'s
      // lock order, not the reducer's emitted order — and the delta folded last
      // still wins.
      //
      // Nothing between the fold loop and here reads `integration_object_keys`,
      // so this transaction observes no value it has not yet written. An edit
      // that resolves an object BY KEY inside the loop would break that: it
      // would read a key this delivery has collected but not issued, and see
      // the old `objectId`. Such an edit must read `pendingKeys` too.
      for (const pending of inKeyLockOrder(pendingKeys)) {
        await tx
          .insert(integrationObjectKeys)
          .values({
            userId: args.userId,
            objectId: pending.objectId,
            provider: args.provider,
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
