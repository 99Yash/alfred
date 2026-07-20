import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PASSTHROUGH_MAX_ARRAY_ITEMS,
  PASSTHROUGH_MAX_BODY_BYTES,
  boundPassthroughBody,
} from "../../../src/modules/tools/passthrough";

const encoder = new TextEncoder();
const bytes = (v: unknown) => encoder.encode(JSON.stringify(v) ?? "").length;

describe("boundPassthroughBody — clean path", () => {
  test("a small body passes through untouched with no truncation signal", () => {
    const body = { id: 1, name: "alfred", tags: ["a", "b"], nested: { ok: true } };
    const r = boundPassthroughBody(body);
    assert.equal(r.truncation, undefined);
    assert.deepEqual(r.value, body);
  });
});

describe("boundPassthroughBody — per-string cap", () => {
  test("a string over 8000 chars is clipped and flagged string_chars", () => {
    const long = "x".repeat(9000);
    const r = boundPassthroughBody({ body: long });
    assert.ok(r.truncation, "expected a truncation signal");
    assert.equal(r.truncation?.handleEligible, true);
    const cause = r.truncation?.causes.find((c) => c.kind === "string_chars");
    assert.ok(cause, "expected a string_chars cause");
    assert.equal(cause?.droppedApprox, 1000);
    const value = r.value as { body: string };
    assert.ok(value.body.length < 9000);
    assert.match(value.body, /truncated/);
  });
});

describe("boundPassthroughBody — array-item cap (any depth)", () => {
  test("a top-level array over 50 items is capped and flagged", () => {
    const items = Array.from({ length: 73 }, (_, i) => i);
    const r = boundPassthroughBody(items);
    const value = r.value as number[];
    assert.equal(value.length, PASSTHROUGH_MAX_ARRAY_ITEMS);
    const cause = r.truncation?.causes.find((c) => c.kind === "array_items");
    assert.equal(cause?.droppedApprox, 73 - PASSTHROUGH_MAX_ARRAY_ITEMS);
  });

  test("a NESTED array is capped — a top-level-only cap would miss it", () => {
    const body = { data: { messages: Array.from({ length: 200 }, (_, i) => ({ i })) } };
    const r = boundPassthroughBody(body);
    const value = r.value as { data: { messages: unknown[] } };
    assert.equal(value.data.messages.length, PASSTHROUGH_MAX_ARRAY_ITEMS);
    const cause = r.truncation?.causes.find((c) => c.kind === "array_items");
    assert.equal(cause?.droppedApprox, 150);
  });
});

describe("boundPassthroughBody — total byte cap", () => {
  test("an oversized body is pruned to valid JSON under (approximately) 32 KiB", () => {
    // 50 rows (already at the array cap) each ~2 KB of short strings → ~100 KB.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      blob: "y".repeat(2000),
    }));
    const r = boundPassthroughBody({ rows });
    assert.ok(bytes({ rows }) > PASSTHROUGH_MAX_BODY_BYTES, "fixture must exceed the cap");

    const cause = r.truncation?.causes.find((c) => c.kind === "body_bytes");
    assert.ok(cause, "expected a body_bytes cause");

    // Always valid JSON.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.value)));
    // Meaningfully reduced, and close to the cap (small slack for sentinels).
    assert.ok(r.truncation!.returnedBytes < r.truncation!.originalBytesApprox);
    assert.ok(bytes(r.value) <= PASSTHROUGH_MAX_BODY_BYTES + 1024);
  });
});

describe("boundPassthroughBody — simultaneous causes", () => {
  test("string, array, and byte caps can all fire in one PassthroughTruncation", () => {
    // 60 rows (>50) each carrying a >8000-char string → all three bounds trip.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      note: "z".repeat(8500),
    }));
    const r = boundPassthroughBody({ rows });
    assert.ok(r.truncation);
    const kinds = new Set(r.truncation?.causes.map((c) => c.kind));
    assert.ok(kinds.has("string_chars"), "string cap should fire");
    assert.ok(kinds.has("array_items"), "array cap should fire");
    assert.ok(kinds.has("body_bytes"), "byte cap should fire");
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.value)));
  });
});

describe("boundPassthroughBody — poison composition", () => {
  test("NUL bytes are stripped as part of the same pass", () => {
    const r = boundPassthroughBody({ text: `ab${String.fromCodePoint(0)}cd` });
    const value = r.value as { text: string };
    assert.equal(value.text, "abcd");
  });
});
