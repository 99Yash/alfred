import { z } from "zod";

/**
 * Narrow env parser for DB-only runtimes (migration tooling, one-off scripts,
 * the `db()` pool factory). Reads ONLY `DATABASE_URL` so a process that just
 * needs Postgres isn't forced to supply the entire {@link import("./server").ServerEnv}
 * schema (Redis, Auth, OAuth, GitHub App, API keys). The full server runtime
 * still validates everything via `serverEnv()`.
 */
const databaseEnvSchema = z.object({
  DATABASE_URL: z.url(),
  /**
   * Upper bound on the shared `pg.Pool` (#437). Every agent-worker step, every
   * other worker, and every HTTP request in the process draw from this one pool,
   * so it has to have headroom for `AGENT_WORKER_CONCURRENCY` concurrent steps —
   * a triage classify step alone opens several reads (thread context, sender
   * prior, sender kind, existing triage row). Oversubscribe it and `pg.Pool`
   * queues *silently*: latency looks the same as a slow model, and HTTP handlers
   * starve behind background work.
   *
   * Defaults to 10 — the previously hardcoded value — so an existing deploy that
   * sets nothing behaves byte-identically.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
});

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
