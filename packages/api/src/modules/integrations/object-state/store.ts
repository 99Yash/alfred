import {
  getObjectDef,
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
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { reduceGithubEvent } from "./github-reducer";

/**
 * Integration object-state store (ADR-0062, #212) — the ADR-0058 swappable
 * abstraction over the `integration_objects` / `_keys` / `_relations` tables.
 * Consumers depend on {@link ObjectStateStore}, never the tables, so the store
 * can be reimplemented without touching the briefing reconciliation or the
 * webhook reducer wiring.
 *
 * State is asserted ONLY here, from the deterministic per-provider reducer over
 * webhook payloads (propose/dispose). `resolveByKey`/`getState` are the read
 * path the briefing loop-closure uses: a CI email's `head_sha` → PR ref →
 * terminal state.
 */

/** The projection delta a per-provider reducer emits for one webhook delivery. */
export interface ObjectStateDelta {
  kind: string;
  externalId: string;
  /** Native-state token the registry's `normalize` maps to a `StateCategory`. */
  nativeState: string;
  title?: string;
  url?: string;
  repo?: string;
  attributes?: Record<string, unknown>;
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
   * Current state for a ref. `at` is reserved for point-in-time reads once
   * supersession rows are written (a fast-follow); v1 mutates a single row in
   * place, so it always returns the live state.
   */
  getState(userId: string, ref: ObjectStateRef, at?: Date): Promise<ObjectState | null>;
  list(
    userId: string,
    provider: ObjectStateProvider,
    filter?: ObjectListFilter,
  ): Promise<ObjectState[]>;
}

type ReduceFn = (
  eventType: string,
  action: string | null,
  payload: unknown,
) => ObjectStateDelta | null;

/** Per-provider reducers. The only per-provider code; everything else is generic. */
const REDUCERS: Record<ObjectStateProvider, ReduceFn> = {
  github: reduceGithubEvent,
};

const DEFAULT_OBJECT_LIST_LIMIT = 100;
const MAX_OBJECT_LIST_LIMIT = 250;

function rowToObjectState(row: IntegrationObject): ObjectState {
  return {
    objectId: row.id,
    provider: row.provider as ObjectStateProvider,
    kind: row.kind,
    externalId: row.externalId,
    // Legal values are guaranteed on the write path by the registry.
    stateCategory: row.stateCategory as StateCategory,
    nativeState: row.nativeState,
    title: row.title,
    url: row.url,
    repo: row.repo,
  };
}

export const objectStateStore: ObjectStateStore = {
  async applyEvent(args) {
    const reduce = REDUCERS[args.provider];
    const delta = reduce(args.eventType, args.action, args.payload);
    if (!delta) return;

    // Native → agnostic bucket. An unrecognized token is a no-op, never a
    // guessed state (absence never closes).
    const stateCategory = getObjectDef(args.provider).normalize(delta.kind, delta.nativeState);
    if (!stateCategory) return;

    await db().transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(integrationObjects)
        .where(
          and(
            eq(integrationObjects.userId, args.userId),
            eq(integrationObjects.provider, args.provider),
            eq(integrationObjects.kind, delta.kind),
            eq(integrationObjects.externalId, delta.externalId),
          ),
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
          })
          .returning({ id: integrationObjects.id });
        if (!row) throw new Error("[object-state] applyEvent insert returned no row");
        objectId = row.id;
      } else {
        objectId = existing.id;
        // Monotonicity: only advance state when this delivery is at least as
        // recent as the one that last set it. Resolved PRs are absorbing, so a
        // delayed open/synchronize delivery can't regress a merge back to active.
        const isNewer =
          existing.stateDeliveredAt === null || args.deliveredAt >= existing.stateDeliveredAt;
        const wouldReopenResolved =
          existing.stateCategory === "resolved" && stateCategory !== "resolved";
        if (isNewer && !wouldReopenResolved) {
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

  async getState(userId, ref) {
    const [row] = await db()
      .select()
      .from(integrationObjects)
      .where(and(eq(integrationObjects.id, ref.objectId), eq(integrationObjects.userId, userId)))
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
