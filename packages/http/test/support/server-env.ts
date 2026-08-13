/**
 * The server environment a composed-app test needs before it makes a request.
 *
 * `serverEnv()` is all-or-nothing and MEMOIZES on its first call, so a suite
 * that reaches a route must supply every variable it parses — not just the two
 * service URLs it actually dials. The values below restate the `env:` block of
 * the `http-tests` CI job so `pnpm --filter @alfred/http test` in a shell with
 * no env file gets the same run the job gets. Nothing here reaches an external
 * provider; the dummies exist only to make the parse succeed.
 *
 * Every key is assigned with `??=`, so a CI job's real `DATABASE_URL` and
 * `REDIS_URL` win over the local defaults.
 *
 * CALL THIS BEFORE `await import("@alfred/http")`, and before any other
 * environment-sensitive module — see
 * `.lessons/import-environment-sensitive-modules-after-test-fixtures.md`. A file
 * that also guards on a service variable must read the guard FIRST: these
 * defaults would otherwise satisfy `dbBackedSkip` on a machine with no Redis.
 */
const SERVER_ENV_FIXTURES: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgresql://localhost:5432/alfred_test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  CORS_ORIGIN: "http://localhost:3000",
  NODE_ENV: "test",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/integrations/google/callback",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
};

/** Fill in every variable `serverEnv()` parses, without overriding an ambient one. */
export function applyServerEnvFixtures(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value; // drift-ok: seeds the fixture environment, does not gate a suite
  }
}
