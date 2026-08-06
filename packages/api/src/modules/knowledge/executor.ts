import type { DbTransaction } from "@alfred/db";

/**
 * A Drizzle transaction handle — the value `db().transaction(cb)` hands its
 * callback. Every write helper in this module optionally takes one so the
 * stable-layer writes (node + identities) and the append + head-pointer upsert
 * can commit atomically inside a reducer's transaction; omit it and each helper
 * opens its own. Mirrors `memory/entities.ts`'s `DbExecutor`.
 */
export type DbExecutor = DbTransaction;
