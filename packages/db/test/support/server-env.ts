/**
 * `serverEnv()` parses every variable at once and memoizes, so a Redis test must set
 * `REDIS_URL` first and fill the rest. These dummies mirror the `db-tests` CI `env:` block
 * and exist only to make the parse pass. `??=` lets a real value from `apps/server/.env` win.
 */
const DUMMIES = {
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
} satisfies Readonly<Record<string, string>>;

/**
 * Call before the first `createRedisConnection(...)`, which memoizes the parse.
 * `REDIS_URL` always overrides, so a probe never talks to an ambient real Redis by accident.
 */
export function applyServerEnv(redisUrl: string): void {
  for (const [key, value] of Object.entries(DUMMIES)) process.env[key] ??= value;
  process.env["REDIS_URL"] = redisUrl; // drift-ok: seeds the fixture environment, does not gate a suite
}
