import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { integrations } from "../src/integrations";
import { once } from "../src/shared/provider";

/**
 * Lifetime guarantees of the bind layer. `once` memoizes client construction, never a credential resolve.
 * Provider getters are memoized, and each client resolves its credential per request, so nothing goes stale.
 */

const RETRY = { maxAttempts: 2 } as const;

describe("once", () => {
  test("runs the builder exactly once and returns the same value", () => {
    let calls = 0;

    const build = once(() => {
      calls += 1;

      return { n: calls };
    });

    const first = build();
    assert.equal(build(), first, "the same reference must come back");
    assert.equal(build(), first);
    assert.equal(calls, 1);
  });

  test("collapses concurrent async callers onto one in-flight run", async () => {
    let runs = 0;

    const run = once(async () => {
      runs += 1;
      await Promise.resolve();

      return "value";
    });

    // Overlapping callers share one promise.
    const [a, b, c] = await Promise.all([run(), run(), run()]);
    assert.equal(runs, 1);
    assert.deepEqual([a, b, c], ["value", "value", "value"]);
  });

  test("caches a rejection rather than re-running the failing builder", async () => {
    let attempts = 0;

    const run = once(async () => {
      attempts += 1;
      throw new Error("construction failed");
    });

    await assert.rejects(run(), /construction failed/);
    await assert.rejects(run(), /construction failed/);
    assert.equal(attempts, 1);
  });

  test("caches undefined — the memo is presence-based, not truthiness-based", () => {
    let calls = 0;

    const build = once(() => {
      calls += 1;

      return undefined;
    });

    build();
    build();
    assert.equal(calls, 1);
  });
});

describe("user-bound integrations", () => {
  test("returns the SAME provider client on repeated access within one bind", () => {
    const bound = integrations({ userId: "user_1", retry: RETRY });
    assert.equal(bound.github, bound.github, "one bind must yield one github client");
    assert.equal(bound.google, bound.google);
    assert.equal(bound.notion, bound.notion);
    assert.equal(bound.vercel, bound.vercel);
  });

  test("a separate bind is a separate client — the memo never crosses users", () => {
    const a = integrations({ userId: "user_1", retry: RETRY });
    const b = integrations({ userId: "user_2", retry: RETRY });
    assert.notEqual(a.github, b.github);
  });

  test("binding builds nothing until a provider is touched", () => {
    // Every provider sits behind a getter, so an unconfigured one cannot fail at bind time.
    const bound = integrations({ userId: "user_1", retry: RETRY });
    assert.deepEqual(Object.keys(bound).sort(), ["github", "google", "notion", "sentry", "vercel"]);
  });
});
