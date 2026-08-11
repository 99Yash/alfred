import assert from "node:assert/strict";
import { describe, test } from "node:test";

/**
 * `@alfred/http` is one barrel with no subpaths, so importing any binding from
 * it evaluates every module it names and everything those modules reach. This
 * file is the detector for the load half of that contract: the whole graph must
 * resolve with no environment variable, no database and no Redis.
 *
 * It is a file of its own on purpose. A behavioural test that happens to import
 * the barrel checks this only by accident, and stops checking it the day someone
 * repoints that import at a concrete sibling module — the spelling
 * `packages/http/src/index.ts` itself recommends — with every gate still green.
 *
 * What it does not cover: a handle retained at module scope. The package's test
 * script runs with `--test-force-exit`, so a module-scope timer or open
 * connection cannot hang this job, and a raw handle count under `tsx` is
 * dominated by the loader's own file-system work. Nothing in the repo reports
 * that clause today.
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
    // Deleted before the dynamic import, so the result does not depend on
    // whether the person running this has a populated shell.
    for (const key of SERVICE_ENV_KEYS) {
      delete process.env[key];
    }

    const bindings = Object.entries(await import("@alfred/http"));

    // Derived from what the barrel actually exports rather than listed here:
    // a list would be one more restatement of the route set to maintain.
    assert.ok(bindings.length > 0, "the barrel resolved no bindings");
    for (const [name, value] of bindings) {
      assert.notEqual(value, undefined, `binding ${name} resolved to undefined`);
    }
  });
});
