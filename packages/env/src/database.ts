import { z } from "zod";
import { agentWorkerConcurrencySchema, derivePoolMax, POOL_MIN } from "./pool";

/**
 * Narrow env parser for DB-only runtimes (migration tooling, one-off scripts,
 * the `db()` pool factory). Reads only what sizing a pool needs, so a process
 * that just needs Postgres isn't forced to supply the entire
 * {@link import("./server").ServerEnv} schema (Redis, Auth, OAuth, GitHub App,
 * API keys). The full server runtime still validates everything via
 * `serverEnv()`.
 */
const databaseEnvSchema = z
  .object({
    DATABASE_URL: z.url(),
    /**
     * Read here purely to *size the pool* — see {@link derivePoolMax}. A DB-only
     * runtime (migrations, a script) has no agent worker, so its concurrency is
     * whatever the env says and the derived ceiling is harmlessly generous.
     */
    AGENT_WORKER_CONCURRENCY: agentWorkerConcurrencySchema,
    /**
     * Explicit override for the derived pool ceiling (#437). Leave it unset:
     * the pool max is a function of `AGENT_WORKER_CONCURRENCY`, not an
     * independent fact, and every deploy that set the two by hand had to
     * remember a coupling nothing enforced. Set it only to deviate from the
     * derivation deliberately — e.g. a Postgres `max_connections` ceiling
     * shared with other services.
     */
    DB_POOL_MAX: z.coerce.number().int().min(POOL_MIN).optional(),
  })
  .transform((env) => ({
    DATABASE_URL: env.DATABASE_URL,
    DB_POOL_MAX: env.DB_POOL_MAX ?? derivePoolMax(env.AGENT_WORKER_CONCURRENCY),
  }));

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

let _databaseEnv: DatabaseEnv | undefined;

export function databaseEnv(): DatabaseEnv {
  if (_databaseEnv) return _databaseEnv;
  const result = databaseEnvSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Missing or invalid database environment variables:\n${formatted}`);
  }
  _databaseEnv = result.data;
  return _databaseEnv;
}
