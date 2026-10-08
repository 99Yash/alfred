import { isIndexable } from "@alfred/contracts";

/** The fields our classifiers read off a pg error or its Drizzle wrapper. */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}

/**
 * Walk the `.cause` chain. Drizzle's `DrizzleQueryError` has no `.code`;
 * the pg `DatabaseError` with `code` sits on `.cause`.
 * Uses `isIndexable`, because `isRecord` rejects class instances. `maxDepth` stops a cause cycle.
 */
export function* pgErrorChain(err: unknown, maxDepth = 5): Generator<PgErrorLike> {
  let cur: unknown = err;

  for (let depth = 0; depth < maxDepth && isIndexable(cur); depth++) {
    // SAFETY: isIndexable proved cur is an object, and every PgErrorLike field is optional.
    yield cur as PgErrorLike;
    cur = Reflect.get(cur, "cause");
  }
}

export const PG_UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  for (const e of pgErrorChain(err)) {
    if (e.code === PG_UNIQUE_VIOLATION) return true;
  }

  return false;
}

/** The unique index a 23505 hit, or `null`. Lets a table with two unique indexes tell them apart. */
export function uniqueViolationConstraint(err: unknown): string | null {
  for (const e of pgErrorChain(err)) {
    if (e.code === PG_UNIQUE_VIOLATION) return e.constraint ?? null;
  }

  return null;
}
