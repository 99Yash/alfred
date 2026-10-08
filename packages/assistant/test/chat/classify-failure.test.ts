import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@alfred/contracts";

import { classifyChatFailure } from "@alfred/assistant/chat/chat-failure-kind";

const NO_IMAGE = { currentTurnHasImage: false, historicalHasImage: false };

const CURRENT_IMAGE = { currentTurnHasImage: true, historicalHasImage: false };

const HISTORICAL_IMAGE = { currentTurnHasImage: false, historicalHasImage: true };

test("ADR-0072: no image anywhere never classifies as attachment, regardless of text", () => {
  // Regression #269: a drive.export_file error mentioning "file" read as `attachment`.
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
  // `attachment` would offer a "Send without it" retry that cannot drop a past image.
  assert.equal(
    classifyChatFailure(new Error("unable to process input image"), HISTORICAL_IMAGE),
    "attachment_history",
  );
});

test("an unrelated tool failure with an image present still classifies generic", () => {
  // A tool error that mentions "file" is not an attachment failure.
  assert.equal(
    classifyChatFailure(new Error("github: file not found in repo"), CURRENT_IMAGE),
    "generic",
  );
});

test("a drive export failure mentioning 'file' stays generic in an image-bearing thread", () => {
  // "unsupported file" or "unsupported media" counts only with an explicit image mention.
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
  // A real image reject that names the image still counts.
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
  assert.equal(
    classifyChatFailure(new Error("prompt is too long for the model"), NO_IMAGE),
    "too_long",
  );
  assert.equal(classifyChatFailure(new Error("something odd"), NO_IMAGE), "generic");
});

test("the streaming circuit-breaker abort classifies timeout, not overloaded", () => {
  // Our stream ceiling throws a `TimeoutError`. That is our breaker, not a provider fault (#406).
  const domTimeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(classifyChatFailure(domTimeout, NO_IMAGE), "timeout");
  // Stringified fallback with the name lost: total-ceiling message.
  assert.equal(
    classifyChatFailure(new Error("The operation was aborted due to timeout"), NO_IMAGE),
    "timeout",
  );
  // Stringified fallback: chunk or step ceiling message.
  assert.equal(
    classifyChatFailure(new Error("chunk timeout of 30000ms exceeded"), NO_IMAGE),
    "timeout",
  );
});

test("a provider transient fault still classifies overloaded (timeout split stays narrow)", () => {
  // Provider faults, including a "gateway timeout", stay `overloaded`.
  const http = (status: number) =>
    new HttpError({ provider: "test", status, url: "https://x.test", body: "" });

  assert.equal(classifyChatFailure(http(503), NO_IMAGE), "overloaded");
  assert.equal(classifyChatFailure(new Error("model is overloaded"), NO_IMAGE), "overloaded");
  assert.equal(classifyChatFailure(new Error("504 gateway timeout"), NO_IMAGE), "overloaded");
});
