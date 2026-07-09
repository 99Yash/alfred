/**
 * Structural narrowing for Postgres driver errors.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose own `.code`
 * is undefined — the node-postgres `DatabaseError` (which carries
 * `code`/`constraint`) sits on `.cause`, so callers walk the short `.cause`
 * chain. These are class instances, NOT JSON, so `isRecord` (which rejects
 * class instances) is the wrong tool here: the per-call structural walk stays
 * explicit (see packages/api/CLAUDE.md).
 *
 * This is the superset of every field the current callers read —
 * `isUniqueViolation` (agent/service) checks `code`; `isObservationAppendConflict`
 * (user-model/observations) also reads `constraint`/`message`. Extra optional
 * fields are harmless at a call site that ignores them.
 */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}
