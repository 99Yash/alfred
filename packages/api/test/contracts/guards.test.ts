import assert from "node:assert/strict";
import test from "node:test";
import {
  getPath,
  getStringPath,
  isIndexable,
  isPlainRecord,
  isRecord,
  toRecord,
} from "@alfred/contracts";

test("isRecord accepts only plain object records", () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isPlainRecord({ a: 1 }), true);

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
