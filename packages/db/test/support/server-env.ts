/**
 * `serverEnv()` is all-or-nothing and MEMOIZES on its first call, so a test that
 * wants a `REDIS_URL` of its own must set it before anything in the process
 * reads the environment — and must supply the other ~20 variables too, or the
 * parse throws and the `REDIS_URL` never matters.
 *
 * The dummies below mirror the `env:` block of the `db-tests` CI job, so a
 * developer running this tree in a shell with no env file gets a parse that
 * succeeds. They do NOT reproduce the CI run: in `db-tests` the identical
 * `DATABASE_URL` points at a live migrated Postgres service, and the two
 * DB-backed suites in this tree reach it. Only the four Redis suites call this
 * helper, and `@alfred/db/redis` reads exactly one field, `REDIS_URL`, so no
 * value below reaches a service from here — the rest exist only to make the
 * parse succeed. Each one is assigned with `??=`, so a real value from
 * `pnpm --filter @alfred/db test:db`, which loads `apps/server/.env`, wins.
 */
const DUMMIES: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgresql://ci:ci@localhost:5432/alfred_ci",
  BETTER_AUTH_SECRET: "ci-dummy-better-auth-secret-32chars-min",
  OAUTH_CREDENTIAL_KEK: "Y2ktZHVtbXkta2VrLTMyLWJ5dGVzLW5vdC1zZWNyZXQ",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "ci@example.com",
  RESEND_API_KEY: "re_ci_dummy",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "ci-dummy",
  GOOGLE_GENERATIVE_AI_API_KEY: "ci-dummy",
  GOOGLE_OAUTH_CLIENT_ID: "ci-dummy",
  GOOGLE_OAUTH_CLIENT_SECRET: "ci-dummy",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/integrations/google/callback",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "ci-dummy",
  GITHUB_APP_CLIENT_ID: "ci-dummy",
  GITHUB_APP_CLIENT_SECRET: "ci-dummy",
  GITHUB_APP_PRIVATE_KEY: "ci-dummy",
  GITHUB_WEBHOOK_SECRET: "ci-dummy",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
};

/**
 * Point the process at `redisUrl` and fill in whatever else `serverEnv()`
 * demands. Call this BEFORE the first `createRedisConnection(...)` in the file:
 * that call is what memoizes the parse, and a later override is silently
 * ignored. `REDIS_URL` is assigned unconditionally — an ambient one from a
 * developer shell or a CI `env:` block must not win over the caller's choice,
 * because a probe that quietly talked to a real Redis instead of the endpoint it
 * built would pass while proving nothing.
 */
export function applyServerEnv(redisUrl: string): void {
  for (const [key, value] of Object.entries(DUMMIES)) process.env[key] ??= value;
  process.env["REDIS_URL"] = redisUrl; // drift-ok: seeds the fixture environment, does not gate a suite
}
