import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { integrations } from "../src/facade";
import { once } from "../src/shared/provider";

/**
 * The bind layer's guarantees, all about LIFETIME rather than behavior — the kind
 * of property that is invisible in a passing happy path and only shows up as a
 * duplicated credential read or a stale token in production.
 *
 *   1. {@link once} runs its builder exactly once and hands back the same value.
 *      In this package it memoizes CLIENT CONSTRUCTION only; the async
 *      properties are pinned for a future caller, not exercised by one today.
 *      Deliberately NOT used on a credential resolve — see `provider.ts`.
 *   2. The facade's provider getters are memoized, so a tool touching `.github`
 *      twice works with ONE client. Since that client resolves its credential per
 *      request, a bind holds nothing that can go stale and imposes no rule about
 *      how long a caller may keep it.
 *
 * No network and no DB: `integrations()` is lazy by construction, so building a
 * client never resolves a credential.
 */

/** Any policy will do here; the point is that the bind has to state one. */
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
    // Deliberately not awaited in sequence: overlapping callers share the promise
    // rather than each starting their own run. No caller in this package needs
    // this today — pinned so the memo's contract is a tested property.
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
    // One failure, reported at every call site that needed it, rather than N
    // retries of a builder that already told us it cannot succeed.
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

describe("integrations facade", () => {
  test("returns the SAME provider client on repeated access within one bind", () => {
    const bound = integrations({ userId: "user_1", retry: RETRY });
    assert.equal(bound.github, bound.github, "one bind must yield one github client");
    assert.equal(bound.vercel, bound.vercel);
  });

  test("a separate bind is a separate client — the memo never crosses users", () => {
    const a = integrations({ userId: "user_1", retry: RETRY });
    const b = integrations({ userId: "user_2", retry: RETRY });
    assert.notEqual(a.github, b.github);
  });

  test("binding builds nothing until a provider is touched", () => {
    // `integrations()` returning without throwing is the assertion: every
    // provider is behind a getter, so an unconfigured provider cannot fail at
    // bind time and a tool pays for only the providers it uses.
    const bound = integrations({ userId: "user_1", retry: RETRY });
    assert.deepEqual(Object.keys(bound).sort(), ["github", "vercel"]);
  });
});
