import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@alfred/contracts";

import { classifyChatFailure } from "../../src/modules/agent/workflows/chat-turn";

const NO_IMAGE = { currentTurnHasImage: false, historicalHasImage: false };
const CURRENT_IMAGE = { currentTurnHasImage: true, historicalHasImage: false };
const HISTORICAL_IMAGE = { currentTurnHasImage: false, historicalHasImage: true };

test("ADR-0072: no image anywhere never classifies as attachment, regardless of text", () => {
  // The #269 incident: a drive.export_file failure whose message mentioned
  // "file" got mis-bucketed as `attachment` on a turn with nothing attached.
  assert.equal(
    classifyChatFailure(new Error("could not process file export"), NO_IMAGE),
    "generic",
  );
  assert.equal(
    classifyChatFailure(new Error("unable to process input image"), NO_IMAGE),
    "generic",
  );
  assert.equal(classifyChatFailure(new Error("invalid image data"), NO_IMAGE), "generic");
});

test("a current-turn image-reject classifies attachment (Send-without-it can recover)", () => {
  assert.equal(
    classifyChatFailure(new Error("unable to process input image"), CURRENT_IMAGE),
    "attachment",
  );
  assert.equal(
    classifyChatFailure(new Error("unsupported image type"), CURRENT_IMAGE),
    "attachment",
  );
  assert.equal(
    classifyChatFailure(new Error("failed to decode image: corrupt"), CURRENT_IMAGE),
    "attachment",
  );
});

test("a historical-only image-reject classifies attachment_history (retry can't reach it)", () => {
  // P1 review: thread-wide gate would have said `attachment` → dead-end
  // "Send without it" retry that only drops the current turn's attachments.
  assert.equal(
    classifyChatFailure(new Error("unable to process input image"), HISTORICAL_IMAGE),
    "attachment_history",
  );
});

test("an unrelated tool failure with an image present still classifies generic", () => {
  // The broad net (attachment|file|image|media|mime) is gone — a tool error that
  // merely mentions "file" must not be mistaken for an attachment failure even
  // when an image is present.
  assert.equal(
    classifyChatFailure(new Error("github: file not found in repo"), CURRENT_IMAGE),
    "generic",
  );
});

test("a drive export failure mentioning 'file' stays generic in an image-bearing thread", () => {
  // The remaining trap: "unsupported file" / "unsupported media" were
  // image-reject signals unconditionally, so a `drive.export_file` error
  // mis-bucketed as `attachment`/`attachment_history` whenever the thread held
  // an image. They now require an explicit image mention.
  assert.equal(
    classifyChatFailure(
      new Error("drive.export_file: unsupported file export type"),
      CURRENT_IMAGE,
    ),
    "generic",
  );
  assert.equal(
    classifyChatFailure(
      new Error("drive.export_file: unsupported file export type"),
      HISTORICAL_IMAGE,
    ),
    "generic",
  );
  assert.equal(
    classifyChatFailure(new Error("unsupported media type: application/zip"), CURRENT_IMAGE),
    "generic",
  );
});

test("an image-named 'unsupported media' still classifies attachment", () => {
  // The narrowing must not regress genuine provider image rejects that phrase
  // themselves as "unsupported media" — as long as an image is named.
  assert.equal(
    classifyChatFailure(new Error("unsupported media type: image/heic"), CURRENT_IMAGE),
    "attachment",
  );
});

test("structured signals still classify correctly (image flags don't touch them)", () => {
  const http = (status: number) =>
    new HttpError({ provider: "test", status, url: "https://x.test", body: "" });
  assert.equal(classifyChatFailure(http(429), NO_IMAGE), "rate_limited");
  assert.equal(classifyChatFailure(http(503), NO_IMAGE), "overloaded");
  assert.equal(classifyChatFailure(new Error("chat_turn_limit_exceeded"), NO_IMAGE), "too_long");
  assert.equal(
    classifyChatFailure(new Error("prompt is too long for the model"), NO_IMAGE),
    "too_long",
  );
  assert.equal(classifyChatFailure(new Error("something odd"), NO_IMAGE), "generic");
});

test("the streaming circuit-breaker abort classifies timeout, not overloaded", () => {
  // The #406-branch incident: a turn that thought for ~200s hit the 180s stream
  // ceiling and the SDK aborted the call with a `TimeoutError` DOMException,
  // which `classifyChatFailure` mis-bucketed as `overloaded` (its transient net
  // matched the bare "timeout" substring). It's our circuit-breaker firing, not
  // a provider fault — so it must read as `timeout`.
  const domTimeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(classifyChatFailure(domTimeout, NO_IMAGE), "timeout");
  // Stringified fallback (raw name lost) — the total-ceiling message.
  assert.equal(
    classifyChatFailure(new Error("The operation was aborted due to timeout"), NO_IMAGE),
    "timeout",
  );
  // Stringified fallback — the chunk/step-ceiling message shape.
  assert.equal(
    classifyChatFailure(new Error("chunk timeout of 30000ms exceeded"), NO_IMAGE),
    "timeout",
  );
});

test("a provider transient fault still classifies overloaded (timeout split stays narrow)", () => {
  // The `timeout` split must not steal genuine transient provider faults: a
  // 5xx, an "overloaded" body, or a provider "gateway timeout" all stay
  // `overloaded` (retryable, but a provider glitch, not our circuit-breaker).
  const http = (status: number) =>
    new HttpError({ provider: "test", status, url: "https://x.test", body: "" });
  assert.equal(classifyChatFailure(http(503), NO_IMAGE), "overloaded");
  assert.equal(classifyChatFailure(new Error("model is overloaded"), NO_IMAGE), "overloaded");
  assert.equal(classifyChatFailure(new Error("504 gateway timeout"), NO_IMAGE), "overloaded");
});
