import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildThreadSnippet, userRepliedAfterMessage } from "@alfred/assistant/triage/thread-state";

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
      buildThreadSnippet(
        "dvd",
        content,
        { from: "Oliv AI <notifications@tasks.clickup.com>", to: "yash.k@oliv.ai" },
        220,
      ),
      "dvd assigned you a comment: please make sure this is fixed",
    );
  });

  test("collapses whitespace/newlines into a single-line lede", () => {
    assert.equal(
      buildThreadSnippet(null, "line one\n\n  line   two\n", {}, 220),
      "line one line two",
    );
  });

  test("caps length with an ellipsis", () => {
    const long = "x".repeat(300);
    const out = buildThreadSnippet(null, long, {}, 220);
    assert.equal(out.length, 221); // 220 chars + the ellipsis glyph
    assert.ok(out.endsWith("…"));
  });

  test("falls back to the title when the body is empty after stripping headers", () => {
    const headersOnly = "From: a@b.com\nSubject: Only headers here\n\n";
    assert.equal(
      buildThreadSnippet("Only headers here", headersOnly, { from: "a@b.com" }, 220),
      "Only headers here",
    );
  });

  test("returns an empty string when there is neither body nor title", () => {
    assert.equal(buildThreadSnippet(null, "", {}, 220), "");
    assert.equal(buildThreadSnippet(null, null, {}, 220), "");
  });
});

// The per-message closure test (ADR-0050 same-thread retraction). `todoSuppressionReason`
// only branches on this boolean, and the whole-thread read has no local harness,
// so the P0 inversion is locked here: on the reply re-eval the user's send is
// newer than the message under classification, but on the NEXT inbound it is
// older — and only the first may suppress the mint.
describe("userRepliedAfterMessage", () => {
  const inboundAt = new Date("2026-09-18T07:36:00Z");
  const replyAt = new Date("2026-09-18T07:48:00Z");
  const nextInboundAt = new Date("2026-09-18T09:00:00Z");

  test("reply after the message closes it (the reply re-eval)", () => {
    assert.equal(userRepliedAfterMessage(replyAt, inboundAt), true);
  });

  test("reply before a newer inbound does NOT close the newer inbound (P0)", () => {
    assert.equal(userRepliedAfterMessage(replyAt, nextInboundAt), false);
  });

  test("a reply at the same instant is not strictly after", () => {
    assert.equal(userRepliedAfterMessage(replyAt, replyAt), false);
  });

  test("no user send never suppresses", () => {
    assert.equal(userRepliedAfterMessage(null, inboundAt), false);
  });

  test("an undated message carries no ordering signal, so it is never suppressed", () => {
    assert.equal(userRepliedAfterMessage(replyAt, null), false);
  });
});
