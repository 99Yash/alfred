import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseEmailAddress } from "@alfred/contracts";

// serverEnv() validates the whole schema on first read, so populate the
// required slots before `selfSenderEmail()` triggers it. `??=` lets a real
// loaded .env win — this test does NOT pin RESEND_FROM_EMAIL to a fixed value;
// it derives the self address from `selfSenderEmail()` itself and asserts the
// envelope-form matching AROUND it, so it holds whatever the address is.
const SERVER_ENV_FIXTURES: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
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
};
for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
  process.env[key] ??= value;
}

// Imported AFTER env is seeded. `selfSenderEmail()` reads serverEnv() lazily on
// first call (inside the tests), so it observes the seeded env.
const { isSelfAuthored, selfSenderEmail } = await import("@alfred/integrations/google");

/**
 * Regression guard for the self-ingestion drop (#211 / #266). Alfred's OWN
 * outbound — the daily briefing AND the HIL-approval mail — both ship through a
 * single path (`notify.ts` → `from: RESEND_FROM_EMAIL`), so one exact-address
 * match covers every Alfred-authored envelope. This locks the two properties the
 * ingestion drop AND the retirement backfill both rely on:
 *   1. the match is on the EXACT parsed address, in BOTH envelope forms (bare
 *      and `"Alfred <addr>"`), so a display-name form is dropped just like a bare
 *      one;
 *   2. a look-alike — a different address, or the same "Alfred" display name over
 *      a DIFFERENT address (spoof) — is NOT dropped.
 *
 * It deliberately does not pin the address: it derives it from `selfSenderEmail()`
 * and builds the cases around it, so it passes for any configured value and can't
 * rot when RESEND_FROM_EMAIL changes.
 */
describe("isSelfAuthored — self-ingestion drop (#211/#266)", () => {
  const self = selfSenderEmail();
  const SKIP = self ? false : "RESEND_FROM_EMAIL has no parseable address — skipping";

  test("drops the self address in its bare form", { skip: SKIP }, () => {
    assert.equal(isSelfAuthored(self), true);
  });

  test("drops the self address in the display-name envelope form (the briefing/HIL sender)", {
    skip: SKIP,
  }, () => {
    assert.equal(isSelfAuthored(`Alfred <${self}>`), true);
    // A different display name over the SAME address is still self.
    assert.equal(isSelfAuthored(`Alfred Briefing <${self}>`), true);
  });

  test("does NOT drop a different sender", { skip: SKIP }, () => {
    assert.equal(isSelfAuthored("someone@example.com"), false);
    assert.equal(isSelfAuthored("A Person <a.person@work.com>"), false);
  });

  test("does NOT drop a spoof: the 'Alfred' display name over a DIFFERENT address", {
    skip: SKIP,
  }, () => {
    assert.equal(isSelfAuthored("Alfred <attacker@evil.com>"), false);
    // The self address embedded only in display text must not match either.
    assert.notEqual(parseEmailAddress(self), "attacker@evil.com");
  });

  test("does NOT drop a null/absent From", () => {
    assert.equal(isSelfAuthored(null), false);
    assert.equal(isSelfAuthored(""), false);
  });
});
