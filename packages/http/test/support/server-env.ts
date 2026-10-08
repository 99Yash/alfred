/**
 * Dummy env so `serverEnv()` parses. It parses every variable at once and memoizes.
 * Covers every required variable except the two service URLs.
 * No service URL here: `dbBackedSkip` reads them for presence, so planting them would stop every skip.
 * Apply before `await import("@alfred/http")`.
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
 * Fill missing variables without overriding ambient ones.
 * Pass `serviceUrls` only from a suite with no `dbBackedSkip` guard.
 */
export function applyServerEnvFixtures(serviceUrls?: {
  databaseUrl: string;
  redisUrl: string;
}): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value; // drift-ok: seeds the fixture environment, does not gate a suite
  }

  if (!serviceUrls) return;
  // `??=` so a CI job's real services win.
  process.env["DATABASE_URL"] ??= serviceUrls.databaseUrl; // drift-ok: opt-in fixture value, does not gate a suite
  process.env["REDIS_URL"] ??= serviceUrls.redisUrl; // drift-ok: opt-in fixture value, does not gate a suite
}
