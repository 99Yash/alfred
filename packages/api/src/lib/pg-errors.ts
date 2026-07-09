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
