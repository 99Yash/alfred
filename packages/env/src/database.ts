import { z } from "zod";

/**
 * Narrow env parser for DB-only runtimes (migration tooling, one-off scripts,
 * the `db()` pool factory). Reads ONLY `DATABASE_URL` so a process that just
 * needs Postgres isn't forced to supply the entire {@link import("./server.js").ServerEnv}
 * schema (Redis, Auth, OAuth, GitHub App, API keys). The full server runtime
 * still validates everything via `serverEnv()`.
 */
const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
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
