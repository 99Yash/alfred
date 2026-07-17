import assert from "node:assert/strict";
import test from "node:test";
import { boundToolResult, TOOL_RESULT_MAX_STRING_CHARS } from "@alfred/contracts";

test("boundToolResult leaves short strings untouched and allocates nothing", () => {
  const input = { title: "feat: x", url: "https://example.com", number: 218 };
  const r = boundToolResult(input);
  assert.equal(r.clipped, 0);
  assert.equal(r.value, input); // same reference — clean path allocates nothing
});

test("boundToolResult clips a long string and reports the omitted count", () => {
  const body = "a".repeat(5000);
  const r = boundToolResult({ body }, 2000);
  const out = (r.value as { body: string }).body;
  assert.equal(r.clipped, 3000);
  assert.ok(out.startsWith("a".repeat(2000)));
  assert.ok(out.includes("[truncated 3000 chars"));
  // The clipped notice is the only thing appended beyond the first `max` chars.
  assert.ok(out.length < 2000 + 120);
});

test("boundToolResult only touches the oversized field, preserving navigational shape", () => {
  const input = {
    title: "Epic: user-model spine",
    url: "https://github.com/99Yash/alfred/issues/218",
    number: 218,
    state: "open",
    body: "x".repeat(4000),
  };
  const r = boundToolResult(input, 2000);
  const out = r.value as typeof input;
  assert.equal(out.title, input.title);
  assert.equal(out.url, input.url);
  assert.equal(out.number, 218);
  assert.equal(out.state, "open");
  assert.ok(out.body.length < input.body.length);
  assert.equal(r.clipped, 2000);
});

test("boundToolResult walks arrays and nested objects", () => {
  const input = {
    messages: [
      { subject: "hi", snippet: "short" },
      { subject: "long", snippet: "z".repeat(3000) },
    ],
  };
  const r = boundToolResult(input, 100);
  const out = r.value as typeof input;
  assert.equal(out.messages[0]?.snippet, "short"); // untouched
  assert.ok((out.messages[1]?.snippet ?? "").includes("[truncated 2900 chars"));
  assert.equal(r.clipped, 2900);
});

test("boundToolResult clips nested failed tool error envelopes", () => {
  const input = { status: "failed", error: { message: "e".repeat(3000) } };
  const r = boundToolResult(input, 200);
  const out = r.value as typeof input;
  assert.equal(out.status, "failed");
  assert.ok(out.error.message.startsWith("e".repeat(200)));
  assert.ok(out.error.message.includes("[truncated 2800 chars"));
  assert.equal(r.clipped, 2800);
});

test("boundToolResult returns arrays/objects by reference when nothing clipped", () => {
  const arr = ["a", "b", { c: "d" }];
  const r = boundToolResult(arr);
  assert.equal(r.value, arr);
  assert.equal(r.clipped, 0);
});

test("boundToolResult preserves non-string scalars and null", () => {
  const input = { n: 42, b: true, z: null, s: "long".repeat(1000) };
  const r = boundToolResult(input, 50);
  const out = r.value as typeof input;
  assert.equal(out.n, 42);
  assert.equal(out.b, true);
  assert.equal(out.z, null);
  assert.ok(out.s.startsWith("longlong"));
});

test("boundToolResult leaves class instances / exotic objects intact", () => {
  const d = new Date("2026-07-01T00:00:00Z");
  const r = boundToolResult({ when: d });
  assert.equal((r.value as { when: Date }).when, d);
  assert.equal(r.clipped, 0);
});

test("boundToolResult defaults to TOOL_RESULT_MAX_STRING_CHARS", () => {
  const under = "a".repeat(TOOL_RESULT_MAX_STRING_CHARS);
  const over = "a".repeat(TOOL_RESULT_MAX_STRING_CHARS + 1);
  assert.equal(boundToolResult(under).clipped, 0);
  assert.equal(boundToolResult(over).clipped, 1);
});
