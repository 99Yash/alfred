import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { boundPassthroughBody } from "../../../../src/tool-runtime/internal/tools/passthrough/bounds";

describe("boundPassthroughBody — clean path", () => {
  test("a small body passes through untouched with no truncation signal", () => {
    const body = { id: 1, name: "alfred", tags: ["a", "b"], nested: { ok: true } };
    const r = boundPassthroughBody(body);
    assert.equal(r.truncation, undefined);
    assert.deepEqual(r.value, body);
  });
});

describe("boundPassthroughBody — poison composition", () => {
  test("NUL bytes are stripped as part of the same pass", () => {
    const r = boundPassthroughBody({ text: `ab${String.fromCodePoint(0)}cd` });
    assert.equal(r.truncation, undefined);
    assert.equal(r.value.text, "abcd");
  });
});
