/**
 * The server environment a composed-app test needs before it makes a request.
 *
 * `serverEnv()` is all-or-nothing and MEMOIZES on its first call, so a suite
 * that reaches a route must supply every variable it parses — not just the two
 * service URLs it actually dials.
 *
 * THE KEY SET, stated exactly, because a near-miss here is what the last review
 * caught: it is every key of the `http-tests` CI job's `env:` block MINUS the
 * two service URLs, PLUS `CORS_ORIGIN` and `NODE_ENV`, which that block leaves
 * to their defaults. THE VALUES ARE LOCAL DUMMIES, not the job's values; they
 * exist only to make the parse succeed and none of them reaches an external
 * provider.
 *
 * NO SERVICE URL LIVES IN THE CONSTANT, and that is the whole shape of this
 * module. `DATABASE_URL` and `REDIS_URL` are the two variables `dbBackedSkip`
 * reads for PRESENCE, so a fixture that planted them would give every guarded
 * suite a guard that can never skip, and would void the property
 * `.github/workflows/ci.yml` claims for its `env:` block — shrink the block and
 * the run reddens. A caller that wants them asks for them
 * ({@link applyServerEnvFixtures}), the same way
 * `packages/db/test/support/server-env.ts` makes its `redisUrl` a required
 * argument. A guarded suite calls the plain form and cannot receive a URL it did
 * not ask for.
 *
 * CALL THIS BEFORE `await import("@alfred/http")`, and before any other
 * environment-sensitive module — see
 * `.lessons/import-environment-sensitive-modules-after-test-fixtures.md`.
 */
const SERVER_ENV_FIXTURES = {
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
} satisfies Readonly<Record<string, string>>;

/**
 * Fill in every variable `serverEnv()` parses EXCEPT the two service URLs,
 * without overriding an ambient one.
 *
 * Pass `serviceUrls` only from a suite that has NO service guard — it dials
 * whatever those URLs name, or a mock standing in for it. A guarded suite omits
 * the argument, so its `dbBackedSkip` reading still sees the true ambient
 * environment and can still skip.
 */
export function applyServerEnvFixtures(serviceUrls?: {
  databaseUrl: string;
  redisUrl: string;
}): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value; // drift-ok: seeds the fixture environment, does not gate a suite
  }
  if (!serviceUrls) return;
  // `??=` here too, so a CI job's real services keep winning over the caller's
  // local defaults.
  process.env["DATABASE_URL"] ??= serviceUrls.databaseUrl; // drift-ok: opt-in fixture value, does not gate a suite
  process.env["REDIS_URL"] ??= serviceUrls.redisUrl; // drift-ok: opt-in fixture value, does not gate a suite
}
