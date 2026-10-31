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
  // A `__proto__: null` key in a literal sets the prototype; it is not an own key.
  const nullProto = { __proto__: null, a: 1 };
  assert.equal(Object.getPrototypeOf(nullProto), null);

  class Box {
    value = 1;
  }

  // `isRecord` takes only `unknown`, so the probes sit in `unknown[]` lists.
  const accepted: unknown[] = [{ a: 1 }, nullProto];

  const rejected: unknown[] = [
    null,
    ["a"],
    new Date("2026-07-01T00:00:00Z"),
    new Map([["a", 1]]),
    new Box(),
  ];

  for (const value of accepted) assert.equal(isRecord(value), true);

  for (const value of rejected) assert.equal(isRecord(value), false);
});

test("isIndexable accepts every non-null reference isRecord rejects", () => {
  class Box {
    value = 1;
  }

  const err = new Error("boom");
  (err as Error & { code?: string }).code = "23505";

  // Objects that isRecord rejects.
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
  // The guards take only `unknown`, so the probes sit in an `unknown[]`.
  const [date, nested, nestedDate]: unknown[] = [
    new Date("2026-07-01T00:00:00Z"),
    { a: { b: 1 } },
    { a: new Date("2026-07-01T00:00:00Z") },
  ];

  assert.deepEqual(toRecord(date), {});
  assert.equal(getPath(nested, "a", "b"), 1);
  assert.equal(getPath(nestedDate, "a", "b"), undefined);
});

test("getStringPath narrows only string leaves", () => {
  const [stringLeaf, numberLeaf, arrayLink]: unknown[] = [
    { a: { b: "ok" } },
    { a: { b: 1 } },
    { a: ["not", "a", "record"] },
  ];

  assert.equal(getStringPath(stringLeaf, "a", "b"), "ok");
  assert.equal(getStringPath(numberLeaf, "a", "b"), undefined);
  assert.equal(getStringPath(arrayLink, "a", "0"), undefined);
});

test("enumGuard narrows to tuple members and rejects everything else", () => {
  const isColor = enumGuard(["red", "green", "blue"] as const);

  assert.equal(isColor("red"), true);
  assert.equal(isColor("blue"), true);

  assert.equal(isColor("yellow"), false);
  assert.equal(isColor(""), false);

  // Non-strings must not slip through `Set.has`.
  assert.equal(isColor(null), false);
  assert.equal(isColor(undefined), false);
  assert.equal(isColor(42), false);
  assert.equal(isColor(["red"]), false);
  assert.equal(isColor({ toString: () => "red" }), false);

  // Two guards share no lookup set.
  const isSize = enumGuard(["sm", "lg"] as const);
  assert.equal(isSize("red"), false);
  assert.equal(isColor("sm"), false);
});

test("isToolRiskTier is the enumGuard projection that gates the MCP approval floor", () => {
  // Only a recognized tier may lower the `mcp.call` approval floor.
  assert.equal(isToolRiskTier("high"), true);
  assert.equal(isToolRiskTier("no_risk"), true);
  assert.equal(isToolRiskTier("critical"), false);
  assert.equal(isToolRiskTier(null), false);
  assert.equal(isToolRiskTier(0), false);
});

test("withDefaults ignores present-undefined overrides that a spread would honor", () => {
  const DEFAULT_POLICY = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

  // Regression: a spread keeps a present `undefined`, so the retry loop silently never sent.
  const override = { maxAttempts: undefined };
  const spread = { ...DEFAULT_POLICY, ...override };
  assert.equal(spread.maxAttempts, undefined);

  const merged = withDefaults(DEFAULT_POLICY, override);
  assert.equal(merged.maxAttempts, 3);

  // 0 and false are real values, not absence.
  assert.deepEqual(withDefaults(DEFAULT_POLICY, { maxAttempts: 5 }), {
    ...DEFAULT_POLICY,
    maxAttempts: 5,
  });
  assert.equal(withDefaults({ retries: 3 }, { retries: 0 }).retries, 0);
  assert.equal(withDefaults({ force: true }, { force: false }).force, false);

  // Returns a copy, never the defaults object itself.
  assert.deepEqual(withDefaults(DEFAULT_POLICY, {}), DEFAULT_POLICY);
  assert.deepEqual(withDefaults(DEFAULT_POLICY), DEFAULT_POLICY);
  assert.notEqual(withDefaults(DEFAULT_POLICY), DEFAULT_POLICY);

  // An undefined function-valued key falls back to the real collaborator.
  const deps = { fetchRow: () => "real" };
  assert.equal(withDefaults(deps, { fetchRow: undefined }).fetchRow(), "real");
  assert.equal(withDefaults(deps, { fetchRow: () => "stub" }).fetchRow(), "stub");

  // Spread semantics for a key the defaults object lacks.
  interface SparseDefaultable {
    a: number;
    b?: number;
  }

  const sparse: SparseDefaultable = { a: 1 };
  assert.deepEqual(withDefaults(sparse, { b: 2 }), { a: 1, b: 2 });
});
