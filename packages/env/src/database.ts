import { z } from "zod";
import { agentWorkerConcurrencySchema, derivePoolMax, POOL_MIN } from "./pool";

/** Env for code that only needs Postgres, so scripts and migrations skip the full server env. */
const databaseEnvSchema = z
  .object({
    DATABASE_URL: z.url(),
    /** Read only to size the pool ({@link derivePoolMax}). */
    AGENT_WORKER_CONCURRENCY: agentWorkerConcurrencySchema,
    /** Overrides the derived pool max, e.g. for a `max_connections` limit shared with other services. */
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
