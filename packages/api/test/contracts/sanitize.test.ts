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

test("sanitizeErrorMessage strips poison from a message string", () => {
  assert.equal(sanitizeErrorMessage(`pg error${NUL} 0x00 here`), "pg error 0x00 here");
});
