import assert from "node:assert/strict";
import { describe, test } from "node:test";

/**
 * The whole `@alfred/http` barrel graph must load with no env, database, or Redis.
 * A separate file, so the check survives when other tests import a concrete module instead.
 * It does not catch a module-scope handle: `--test-force-exit` hides it.
 */
const SERVICE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OAUTH_CREDENTIAL_KEK",
  "OPENAI_API_KEY",
  "REDIS_URL",
];

describe("@alfred/http barrel", () => {
  test("loads with every service environment variable unset", async () => {
    // Delete first, so a populated shell cannot change the result.
    for (const key of SERVICE_ENV_KEYS) {
      delete process.env[key];
    }

    const bindings = Object.entries(await import("@alfred/http"));

    assert.ok(bindings.length > 0, "the barrel resolved no bindings");

    for (const [name, value] of bindings) {
      assert.notEqual(value, undefined, `binding ${name} resolved to undefined`);
    }
  });
});
