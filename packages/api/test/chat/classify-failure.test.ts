import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@alfred/contracts";

import { classifyChatFailure } from "../../src/modules/agent/workflows/chat-turn";

const NO_ATTACHMENT = { turnHadAttachment: false };
const WITH_ATTACHMENT = { turnHadAttachment: true };

test("ADR-0072: a no-attachment turn never classifies as attachment, regardless of text", () => {
  // The #269 incident: a drive.export_file failure whose message mentioned
  // "file" got mis-bucketed as `attachment` on a turn with nothing attached.
  assert.equal(
    classifyChatFailure(new Error("could not process file export"), NO_ATTACHMENT),
    "generic",
  );
  assert.equal(
    classifyChatFailure(new Error("unable to process input image"), NO_ATTACHMENT),
    "generic",
  );
  assert.equal(classifyChatFailure(new Error("invalid image data"), NO_ATTACHMENT), "generic");
});

test("ADR-0072: the genuine provider image-reject classifies attachment only when one was sent", () => {
  assert.equal(
    classifyChatFailure(new Error("unable to process input image"), WITH_ATTACHMENT),
    "attachment",
  );
  assert.equal(classifyChatFailure(new Error("unsupported image type"), WITH_ATTACHMENT), "attachment");
  assert.equal(
    classifyChatFailure(new Error("failed to decode image: corrupt"), WITH_ATTACHMENT),
    "attachment",
  );
});

test("an unrelated tool failure on an attachment-bearing turn still classifies generic", () => {
  // The broad net (attachment|file|image|media|mime) is gone — a tool error that
  // merely mentions "file" must not be mistaken for an attachment failure even
  // when an attachment is present.
  assert.equal(
    classifyChatFailure(new Error("github: file not found in repo"), WITH_ATTACHMENT),
    "generic",
  );
});

test("structured signals still classify correctly (gate doesn't touch them)", () => {
  const http = (status: number) =>
    new HttpError({ provider: "test", status, url: "https://x.test", body: "" });
  assert.equal(classifyChatFailure(http(429), NO_ATTACHMENT), "rate_limited");
  assert.equal(classifyChatFailure(http(503), NO_ATTACHMENT), "overloaded");
  assert.equal(
    classifyChatFailure(new Error("chat_turn_limit_exceeded"), NO_ATTACHMENT),
    "too_long",
  );
  assert.equal(
    classifyChatFailure(new Error("prompt is too long for the model"), NO_ATTACHMENT),
    "too_long",
  );
  assert.equal(classifyChatFailure(new Error("something odd"), NO_ATTACHMENT), "generic");
});
