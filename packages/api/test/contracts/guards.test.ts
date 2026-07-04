import assert from "node:assert/strict";
import test from "node:test";
import { getPath, getStringPath, isPlainRecord, isRecord, toRecord } from "@alfred/contracts";

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
