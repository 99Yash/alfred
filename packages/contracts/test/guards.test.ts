import assert from "node:assert/strict";
import test from "node:test";
import {
  enumGuard,
  getPath,
  getStringPath,
  isIndexable,
  isRecord,
  isToolRiskTier,
  toRecord,
  withDefaults,
} from "@alfred/contracts";

test("isRecord accepts only plain object records", () => {
  assert.equal(isRecord({ a: 1 }), true);

  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto.a = 1;
  assert.equal(isRecord(nullProto), true);

  class Box {
    value = 1;
  }

  assert.equal(isRecord(null), false);
  assert.equal(isRecord(["a"]), false);
  assert.equal(isRecord(new Date("2026-07-01T00:00:00Z")), false);
  assert.equal(isRecord(new Map([["a", 1]])), false);
  assert.equal(isRecord(new Box()), false);
});

test("isIndexable accepts every non-null reference isRecord rejects", () => {
  class Box {
    value = 1;
  }
  const err = new Error("boom");
  (err as Error & { code?: string }).code = "23505";

  // Runtime objects isRecord deliberately rejects — the whole point of the guard.
  assert.equal(isIndexable({ a: 1 }), true);
  assert.equal(isIndexable(["a"]), true);
  assert.equal(isIndexable(new Date("2026-07-01T00:00:00Z")), true);
  assert.equal(isIndexable(new Map([["a", 1]])), true);
  assert.equal(isIndexable(new Box()), true);
  assert.equal(isIndexable(err), true);
  assert.equal(
    isIndexable(() => 1),
    true,
  );

  // Primitives and null are the only things excluded.
  assert.equal(isIndexable(null), false);
  assert.equal(isIndexable(undefined), false);
  assert.equal(isIndexable("23505"), false);
  assert.equal(isIndexable(0), false);
  assert.equal(isIndexable(false), false);

  // A caught error narrows to `object`, so `Reflect.get` reads with no cast.
  if (isIndexable(err)) {
    assert.equal(Reflect.get(err, "code"), "23505");
  }
});

test("toRecord and getPath use the same strict record boundary", () => {
  assert.deepEqual(toRecord(new Date("2026-07-01T00:00:00Z")), {});
  assert.equal(getPath({ a: { b: 1 } }, "a", "b"), 1);
  assert.equal(getPath({ a: new Date("2026-07-01T00:00:00Z") }, "a", "b"), undefined);
});

test("getStringPath narrows only string leaves", () => {
  assert.equal(getStringPath({ a: { b: "ok" } }, "a", "b"), "ok");
  assert.equal(getStringPath({ a: { b: 1 } }, "a", "b"), undefined);
  assert.equal(getStringPath({ a: ["not", "a", "record"] }, "a", "0"), undefined);
});

test("enumGuard narrows to tuple members and rejects everything else", () => {
  const isColor = enumGuard(["red", "green", "blue"] as const);

  // Members of the tuple pass.
  assert.equal(isColor("red"), true);
  assert.equal(isColor("blue"), true);

  // A non-member string fails — the whole point over a bare `typeof === "string"`.
  assert.equal(isColor("yellow"), false);
  assert.equal(isColor(""), false);

  // The `typeof` arm makes the `unknown` overload sound: no non-string value can
  // slip through `Set.has`, so persisted/wire junk is rejected, not coerced.
  assert.equal(isColor(null), false);
  assert.equal(isColor(undefined), false);
  assert.equal(isColor(42), false);
  assert.equal(isColor(["red"]), false);
  assert.equal(isColor({ toString: () => "red" }), false);

  // Two guards keep independent lookup sets — no cross-talk through the closure.
  const isSize = enumGuard(["sm", "lg"] as const);
  assert.equal(isSize("red"), false);
  assert.equal(isColor("sm"), false);
});

test("isToolRiskTier is the enumGuard projection that gates the MCP approval floor", () => {
  // The security-relevant use: a persisted `riskTier` is `unknown` until proven,
  // and only a recognized tier may lower the `mcp.call` approval floor.
  assert.equal(isToolRiskTier("high"), true);
  assert.equal(isToolRiskTier("no_risk"), true);
  assert.equal(isToolRiskTier("critical"), false);
  assert.equal(isToolRiskTier(null), false);
  assert.equal(isToolRiskTier(0), false);
});

test("withDefaults ignores present-undefined overrides that a spread would honor", () => {
  const DEFAULT_POLICY = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

  // The regression this helper exists for. A spread honors a present `undefined`,
  // so the retry loop's `attempt <= policy.maxAttempts` reads `undefined` and the
  // request is never sent — silently, with nothing thrown.
  const override = { maxAttempts: undefined };
  const spread = { ...DEFAULT_POLICY, ...override };
  assert.equal(spread.maxAttempts, undefined);

  const merged = withDefaults(DEFAULT_POLICY, override);
  assert.equal(merged.maxAttempts, 3);

  // A real override still wins, and 0 / false are real values, not absence.
  assert.deepEqual(withDefaults(DEFAULT_POLICY, { maxAttempts: 5 }), {
    ...DEFAULT_POLICY,
    maxAttempts: 5,
  });
  assert.equal(withDefaults({ retries: 3 }, { retries: 0 }).retries, 0);
  assert.equal(withDefaults({ force: true }, { force: false }).force, false);

  // No overrides at all, and an undefined overrides argument, both yield the
  // defaults — and never the defaults object itself, so callers may mutate.
  assert.deepEqual(withDefaults(DEFAULT_POLICY, {}), DEFAULT_POLICY);
  assert.deepEqual(withDefaults(DEFAULT_POLICY), DEFAULT_POLICY);
  assert.notEqual(withDefaults(DEFAULT_POLICY), DEFAULT_POLICY);

  // Injected dependencies are the other call shape: a function-valued key must
  // fall back to the real collaborator, not become undefined and blow up on call.
  const deps = { fetchRow: () => "real" };
  assert.equal(withDefaults(deps, { fetchRow: undefined }).fetchRow(), "real");
  assert.equal(withDefaults(deps, { fetchRow: () => "stub" }).fetchRow(), "stub");

  // Faithful to spread semantics for a key the defaults object doesn't enumerate.
  interface SparseDefaultable {
    a: number;
    b?: number;
  }
  const sparse: SparseDefaultable = { a: 1 };
  assert.deepEqual(withDefaults(sparse, { b: 2 }), { a: 1, b: 2 });
});
