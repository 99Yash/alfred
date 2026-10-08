import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseEmailAddress } from "@alfred/contracts";

// `serverEnv()` validates every field on first read. `??=` lets a real .env win.
const SERVER_ENV_FIXTURES = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <hey@alfred.beauty>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
  ENTITY_ID_NAMESPACE: "stable namespace secret for tests",
} satisfies Record<string, string>;

for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
  process.env[key] ??= value;
}

// Import after the env is seeded.
const { isSelfAuthored, selfSenderEmail } = await import("../src/google/index");

/**
 * Alfred sends all its mail from `RESEND_FROM_EMAIL`, so one exact-address match drops it.
 * Both envelope forms match. A look-alike address, or "Alfred" over another address, does not.
 */
describe("isSelfAuthored — self-ingestion drop (#211/#266)", () => {
  const self = selfSenderEmail();
  // Not `dbBackedSkip`: a test-level skip still shows in `# skipped`, and this is config, not a service.
  const SKIP = self ? false : "RESEND_FROM_EMAIL has no parseable address — skipping";

  test("drops the self address in its bare form", { skip: SKIP }, () => {
    assert.equal(isSelfAuthored(self), true);
  });

  test(
    "drops the self address in the display-name envelope form (the briefing/HIL sender)",
    {
      skip: SKIP,
    },
    () => {
      assert.equal(isSelfAuthored(`Alfred <${self}>`), true);
      // A different display name over the SAME address is still self.
      assert.equal(isSelfAuthored(`Alfred Briefing <${self}>`), true);
    },
  );

  test("does NOT drop a different sender", { skip: SKIP }, () => {
    assert.equal(isSelfAuthored("someone@example.com"), false);
    assert.equal(isSelfAuthored("A Person <a.person@work.com>"), false);
  });

  test(
    "does NOT drop a spoof: the 'Alfred' display name over a DIFFERENT address",
    {
      skip: SKIP,
    },
    () => {
      assert.equal(isSelfAuthored("Alfred <attacker@evil.com>"), false);
      // The self address embedded only in display text must not match either.
      assert.notEqual(parseEmailAddress(self), "attacker@evil.com");
    },
  );

  test("does NOT drop a null/absent From", () => {
    assert.equal(isSelfAuthored(null), false);
    assert.equal(isSelfAuthored(""), false);
  });
});
