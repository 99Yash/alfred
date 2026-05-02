import type { ReadonlyJSONValue } from "replicache";

/**
 * Single registry of every Replicache IDB key shape.
 *
 * Each entry is a function that returns a key. Calling with `{}` produces
 * the *prefix* (`note/`, `fact/`) for `tx.scan({ prefix })`; calling with
 * `{ id }` produces a single-row key (`note/abc`, `fact/abc`). Same call
 * site for both — eliminates the per-entity `xPrefix` constant + `xKey()`
 * function pair.
 *
 * Why one map: the server's pull dispatcher (`packages/api/.../pull.ts`)
 * iterates `Object.keys(IDB_KEY)` to emit patches generically — adding a
 * new synced entity is one line here, no per-entity loop on the server.
 *
 * Pattern adapted from the dimension/replicache-cvr reference repo.
 */

function constructIDBKey(parts: (string | null | undefined | number)[]): string {
  return parts.filter((p) => p !== undefined && p !== null).join("/");
}

export const IDB_KEY = {
  /** `note/` (prefix scan) or `note/{id}` (single row). */
  NOTE: ({ id = "" }: { id?: string }) => constructIDBKey(["note", id]),
  /** `fact/` (prefix scan) or `fact/{id}` (single row). */
  FACT: ({ id = "" }: { id?: string }) => constructIDBKey(["fact", id]),
} as const;

/** Union of every entity slug in the registry — drives generic dispatchers. */
export type IDBKeys = keyof typeof IDB_KEY;

/** All entity slugs as a runtime array — server iterates over this. */
export const IDB_KEY_NAMES = Object.keys(IDB_KEY) as IDBKeys[];

/**
 * Cast through `ReadonlyJSONValue` — Replicache's `tx.set` is strict and
 * Drizzle/server-shaped types don't always satisfy it on the nose. The
 * runtime value is always JSON-serializable; the cast is just to make
 * TS happy at the boundary.
 */
export function normalizeToReadonlyJSON<T>(value: T): ReadonlyJSONValue {
  return value as unknown as ReadonlyJSONValue;
}
