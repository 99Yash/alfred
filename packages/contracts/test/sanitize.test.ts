import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeErrorMessage, sanitizeToolResult } from "@alfred/contracts";

const NUL = String.fromCharCode(0);

test("sanitizeToolResult strips NUL bytes from a plain string", () => {
  const r = sanitizeToolResult(`clean${NUL}text${NUL}here`);
  assert.equal(r.value, "cleantexthere");
  assert.equal(r.removed, 2);
});

test("sanitizeToolResult strips lone surrogates but keeps valid pairs (emoji)", () => {
  // A lone high surrogate (no trailing low) and a lone low surrogate.
  const lone = sanitizeToolResult("a\uD800b\uDC00c");
  assert.equal(lone.value, "abc");
  assert.equal(lone.removed, 2);

  // A well-formed pair (😀 = U+1F600) must survive untouched.
  const emoji = sanitizeToolResult("hi 😀!");
  assert.equal(emoji.value, "hi 😀!");
  assert.equal(emoji.removed, 0);
});

test("sanitizeToolResult walks nested structures", () => {
  const input = {
    a: `x${NUL}y`,
    b: ["ok", `bad${NUL}`, { c: `deep${NUL}` }],
    n: 42,
    z: null,
  };
  const r = sanitizeToolResult(input);
  assert.deepEqual(r.value, {
    a: "xy",
    b: ["ok", "bad", { c: "deep" }],
    n: 42,
    z: null,
  });
  assert.equal(r.removed, 3);
});

test("sanitizeToolResult strips poison from object keys, not only values", () => {
  const input = { [`bad${NUL}key`]: "val" };
  const r = sanitizeToolResult(input);
  assert.deepEqual(r.value, { badkey: "val" });
  assert.equal(r.removed, 1);
  assert.equal(r.collisions, 0);
});

test("sanitizeToolResult preserves both values on a key collision (no silent overwrite)", () => {
  // "ab" and "a\0b" both strip to "ab"; the second must not clobber the first.
  const input = { ab: 1, [`a${NUL}b`]: 2 };
  const r = sanitizeToolResult(input);
  assert.equal(r.collisions, 1);
  const out: Record<string, unknown> = r.value;
  assert.equal(out.ab, 1, "the original clean key keeps its value");
  // The colliding entry is preserved under a disambiguated key, not dropped.
  const values = Object.values(out);
  assert.ok(values.includes(2), "the colliding value is preserved, not lost");
  assert.equal(Object.keys(out).length, 2, "both entries survive");
});

test("sanitizeToolResult passes non-string scalars through and allocates nothing when clean", () => {
  assert.equal(sanitizeToolResult(42).value, 42);
  assert.equal(sanitizeToolResult(true).value, true);
  assert.equal(sanitizeToolResult(null).value, null);
  assert.equal(sanitizeToolResult(undefined).value, undefined);

  const clean = { a: "fine", b: [1, 2, "three"] };
  const r = sanitizeToolResult(clean);
  assert.equal(r.value, clean); // same reference — no rebuild on the clean path
  assert.equal(r.removed, 0);
});

test("sanitizeToolResult leaves exotic objects intact by reference", () => {
  // The <T> generic's soundness claim ("rebuild keeps the input's static
  // shape") depends on `isRecord` rejecting non-plain prototypes so they take
  // the passthrough instead of being flattened into bare objects. Pin it
  // directly here — a loosened `isRecord` must fail this test, not silently
  // start lying about the returned type.
  class Instance {
    constructor(readonly note: string) {}
    method(): string {
      return this.note;
    }
  }
  const date = new Date("2026-08-24T00:00:00Z");
  const map = new Map([["k", `poison${NUL}`]]);
  const instance = new Instance(`keep${NUL}`);
  const nested = { when: date, who: instance };

  const r = sanitizeToolResult(nested);
  assert.equal(r.value.when, date, "Date passes through by reference");
  assert.equal(r.value.who, instance, "class instance passes through by reference");
  assert.ok(r.value.who instanceof Instance, "prototype is preserved");
  assert.equal(map.get("k"), `poison${NUL}`, "unwalked Map is untouched");

  const direct = sanitizeToolResult(instance);
  assert.equal(direct.value, instance);
});

test("sanitizeErrorMessage strips poison from a message string", () => {
  assert.equal(sanitizeErrorMessage(`pg error${NUL} 0x00 here`), "pg error 0x00 here");
});

test("sanitizeErrorMessage bounds the result to `max` code units", () => {
  const out = sanitizeErrorMessage("x".repeat(5000), 4000);
  assert.equal(out.length, 4000, "truncated to max");
});

test("sanitizeErrorMessage leaves a shorter-than-max message untouched", () => {
  assert.equal(sanitizeErrorMessage("short message", 4000), "short message");
});

test("sanitizeErrorMessage omitting max preserves the full length (today's behavior)", () => {
  const long = "y".repeat(5000);
  assert.equal(sanitizeErrorMessage(long).length, 5000, "no truncation without max");
});

test("sanitizeErrorMessage truncation is surrogate-safe at the boundary", () => {
  const max = 4000;
  // Build a string whose astral pair (😀 = one high + one low surrogate) straddles
  // `max`: the first half of the pair sits at index max-1, the second at max, so a
  // naive slice(0, max) would orphan the high surrogate into lone poison.
  const message = "a".repeat(max - 1) + "😀";
  const out = sanitizeErrorMessage(message, max);
  assert.ok(out.length <= max, "result is within the bound");
  // The re-strip after slice removes any orphaned half, so the result round-trips
  // clean through the poison regex (a lone surrogate would be stripped again).
  assert.equal(sanitizeErrorMessage(out), out, "no lone surrogate survives the truncation");
});
