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
