import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildThreadSnippet } from "../../src/modules/triage/thread-state";

describe("buildThreadSnippet", () => {
  test("strips the leading RFC-822 header block and leads with the body", () => {
    const content = [
      "From: Oliv AI <notifications@tasks.clickup.com>",
      "To: yash.k@oliv.ai",
      "Subject: dvd",
      "Date: 2026-06-12T17:44:44.000Z",
      "",
      "dvd assigned you a comment: please make sure this is fixed",
    ].join("\n");
    assert.equal(
      buildThreadSnippet("dvd", content, 220),
      "dvd assigned you a comment: please make sure this is fixed",
    );
  });

  test("collapses whitespace/newlines into a single-line lede", () => {
    assert.equal(buildThreadSnippet(null, "line one\n\n  line   two\n", 220), "line one line two");
  });

  test("caps length with an ellipsis", () => {
    const long = "x".repeat(300);
    const out = buildThreadSnippet(null, long, 220);
    assert.equal(out.length, 221); // 220 chars + the ellipsis glyph
    assert.ok(out.endsWith("…"));
  });

  test("falls back to the title when the body is empty after stripping headers", () => {
    const headersOnly = "From: a@b.com\nSubject: Only headers here\n";
    assert.equal(buildThreadSnippet("Only headers here", headersOnly, 220), "Only headers here");
  });

  test("returns an empty string when there is neither body nor title", () => {
    assert.equal(buildThreadSnippet(null, "", 220), "");
    assert.equal(buildThreadSnippet(null, null, 220), "");
  });
});
