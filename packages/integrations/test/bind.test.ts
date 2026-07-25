import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { integrations } from "../src/facade";
import { once } from "../src/shared/provider";

/**
 * The bind layer's two guarantees, both about LIFETIME rather than behavior — the
 * kind of property that is invisible in a passing happy path and only shows up as
 * a duplicated credential read or a stale token in production.
 *
 *   1. {@link once} resolves at most once per bind and collapses concurrent
 *      callers onto one in-flight promise.
 *   2. The facade's provider getters are memoized, so a tool touching
 *      `.github` twice works with ONE client — which is what makes the
 *      client's own bind-scoped resolve a per-request resolve rather than a
 *      per-property-access one.
 *
 * No network and no DB: `integrations()` is lazy by construction, so building a
 * client never resolves a credential.
 */

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

  test("collapses concurrent async callers onto one in-flight resolve", async () => {
    let resolves = 0;
    const resolve = once(async () => {
      resolves += 1;
      await Promise.resolve();
      return "credential";
    });
    // Deliberately not awaited in sequence: the point is that overlapping callers
    // share the promise, which is what a client's `connectedLogin()` + `search()`
    // pair does within one tool call.
    const [a, b, c] = await Promise.all([resolve(), resolve(), resolve()]);
    assert.equal(resolves, 1);
    assert.deepEqual([a, b, c], ["credential", "credential", "credential"]);
  });

  test("caches a rejection rather than re-running the failing builder", async () => {
    let attempts = 0;
    const resolve = once(async () => {
      attempts += 1;
      throw new Error("no active credential");
    });
    await assert.rejects(resolve(), /no active credential/);
    await assert.rejects(resolve(), /no active credential/);
    // One failure, reported at every call site that needed it — not N lookups
    // against a credential that will not resolve inside this request.
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
    const bound = integrations({ userId: "user_1" });
    assert.equal(bound.github, bound.github, "one bind must yield one github client");
    assert.equal(bound.vercel, bound.vercel);
  });

  test("a separate bind is a separate client — the memo never crosses users", () => {
    const a = integrations({ userId: "user_1" });
    const b = integrations({ userId: "user_2" });
    assert.notEqual(a.github, b.github);
  });

  test("binding builds nothing until a provider is touched", () => {
    // `integrations()` returning without throwing is the assertion: every
    // provider is behind a getter, so an unconfigured provider cannot fail at
    // bind time and a tool pays for only the providers it uses.
    const bound = integrations({ userId: "user_1" });
    assert.deepEqual(Object.keys(bound).sort(), ["github", "vercel"]);
  });
});
