import { isIndexable } from "@alfred/contracts";

/**
 * Drizzle query execution wraps pg driver errors in `DrizzleQueryError`.
 * The wrapper itself has no SQLSTATE `.code`; node-postgres' `DatabaseError`
 * sits on `.cause` and carries `code` / `constraint`. These are class
 * instances, not JSON payloads, so `isRecord` is deliberately the wrong guard.
 *
 * This is the union of fields read by pg-error classifiers in this package.
 */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}

/**
 * Walk the `.cause` chain of a caught value, yielding each level viewed as a
 * `PgErrorLike`. Because Drizzle wraps the driver error, every classifier has
 * to inspect the chain rather than only the top level — otherwise a wrapped
 * violation reads as a generic failure and the recovery path never fires.
 *
 * The levels are class instances (`DrizzleQueryError`, node-postgres
 * `DatabaseError`), so traversal is guarded with `isIndexable`, not `isRecord`;
 * the latter would reject them. The `maxDepth` bound is also what makes a
 * self-referential `.cause` terminate instead of looping forever.
 */
export function* pgErrorChain(err: unknown, maxDepth = 5): Generator<PgErrorLike> {
  let cur: unknown = err;
  for (let depth = 0; depth < maxDepth && isIndexable(cur); depth++) {
    yield cur as PgErrorLike;
    cur = Reflect.get(cur, "cause");
  }
}

/** SQLSTATE class 23 — unique-violation (a duplicate key / partial-index collision). */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * `true` when the given error is a Postgres unique-violation (SQLSTATE 23505).
 * Callers use it to detect a duplicate key and recover (return the in-flight
 * row / 409 / no-op) instead of leaking the raw constraint name.
 *
 * Walks the `.cause` chain via {@link pgErrorChain}: Drizzle query execution
 * wraps pg driver errors in a `DrizzleQueryError` whose own `.code` is
 * undefined — the node-postgres `DatabaseError` that carries `code: "23505"`
 * sits on `.cause`. Checking only the top-level error would read a wrapped
 * violation as a generic failure and skip the recovery path.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (const e of pgErrorChain(err)) {
    if (e.code === PG_UNIQUE_VIOLATION) return true;
  }
  return false;
}

/**
 * The name of the unique index a 23505 violated, or `null` if the error is not
 * a unique violation. Lets a caller that owns more than one partial unique
 * index (e.g. the chat turn kick: a `userMessageId` dedup index and a
 * per-thread active-run index) tell WHICH invariant collided and branch
 * accordingly — double-submit recovery vs. a typed "thread busy" response
 * (#488). Walks the same wrapped-cause chain as {@link isUniqueViolation};
 * node-postgres carries the index name on `.constraint`.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  for (const e of pgErrorChain(err)) {
    if (e.code === PG_UNIQUE_VIOLATION) return e.constraint ?? null;
  }
  return null;
}
