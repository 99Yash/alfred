import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isPassThrough,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES_PER_FILE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MODEL_ATTACHMENT_BYTES_PER_IMAGE,
  MAX_MODEL_ATTACHMENT_BYTES_PER_TURN,
} from "@alfred/contracts";
import sharp from "sharp";

import {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
  assertStoredAttachmentBytesMatch,
  assertUploadAllowed,
  toAttachmentRow,
  validateStoredMeta,
} from "@alfred/assistant/chat/attachments/attachments";

describe("assertAttachmentBatchAllowed", () => {
  test("per-file raw image cap fits under the primary provider's base64 image cap", () => {
    const encodedBytes = Math.ceil(MAX_ATTACHMENT_BYTES_PER_FILE / 3) * 4;
    assert.ok(encodedBytes <= MAX_MODEL_ATTACHMENT_BYTES_PER_IMAGE);
  });

  test("raw batch cap fits inside the base64 model payload budget", () => {
    const encodedBytes = Math.ceil(MAX_ATTACHMENT_BYTES_PER_MESSAGE / 3) * 4;
    assert.ok(encodedBytes <= MAX_MODEL_ATTACHMENT_BYTES_PER_TURN);
  });

  test("accepts a batch within count and aggregate byte limits", () => {
    assert.doesNotThrow(() =>
      assertAttachmentBatchAllowed([
        { size: Math.floor(MAX_ATTACHMENT_BYTES_PER_MESSAGE / 2) },
        { size: Math.floor(MAX_ATTACHMENT_BYTES_PER_MESSAGE / 2) },
      ]),
    );
  });

  test("rejects too many attachments", () => {
    assert.throws(
      () =>
        assertAttachmentBatchAllowed(
          Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => ({ size: 1 })),
        ),
      /up to/,
    );
  });

  test("rejects aggregate bytes over the model-safe message cap", () => {
    assert.throws(
      () => assertAttachmentBatchAllowed([{ size: MAX_ATTACHMENT_BYTES_PER_MESSAGE }, { size: 1 }]),
      /combined limit/,
    );
  });

  test("does not accept GIF as phase-1 pass-through", () => {
    assert.equal(isPassThrough("image/gif"), false);
    assert.throws(() => assertUploadAllowed("image/gif", 1), /Only images and PDFs/);
  });

  test("accepts PDFs but keeps other degrade-text types gated", () => {
    assert.doesNotThrow(() => assertUploadAllowed("application/pdf", 1));
    assert.throws(() => assertUploadAllowed("audio/mpeg", 1), /Only images and PDFs/);
    assert.throws(
      () =>
        assertUploadAllowed(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          1,
        ),
      /Only images and PDFs/,
    );
  });
});

describe("assertStoredAttachmentBytesMatch", () => {
  test("accepts an identical retry", () => {
    assert.doesNotThrow(() =>
      assertStoredAttachmentBytesMatch({
        storedBytes: new Uint8Array([1, 2, 3]),
        candidateBytes: new Uint8Array([1, 2, 3]),
      }),
    );
  });

  test("rejects different bytes with the same length", () => {
    assert.throws(
      () =>
        assertStoredAttachmentBytesMatch({
          storedBytes: new Uint8Array([1, 2, 3]),
          candidateBytes: new Uint8Array([1, 9, 3]),
        }),
      /different bytes/,
    );
  });
});

describe("toAttachmentRow", () => {
  test("preserves an explicit OCR-only null instead of omitting the domain state", () => {
    const row = toAttachmentRow({
      userId: "user-1",
      threadId: "thread-1",
      messageId: "message-1",
      attachment: {
        id: "attachment-1",
        name: "scan.pdf",
        mime: "application/pdf",
        size: 123,
        position: 0,
      },
      degradation: { kind: "pdf", text: null },
    });

    assert.equal(Object.hasOwn(row, "degradedText"), true);
    assert.equal(row.degradedText, null);
  });

  test("omits PDF degradation state from an image row", () => {
    const row = toAttachmentRow({
      userId: "user-1",
      threadId: "thread-1",
      messageId: "message-1",
      attachment: {
        id: "attachment-1",
        name: "photo.png",
        mime: "image/png",
        size: 123,
        position: 0,
      },
      degradation: { kind: "image" },
    });

    assert.equal(Object.hasOwn(row, "degradedText"), false);
  });

  test("rejects a degradation state that does not match the MIME family", () => {
    assert.throws(
      () =>
        toAttachmentRow({
          userId: "user-1",
          threadId: "thread-1",
          messageId: "message-1",
          attachment: {
            id: "attachment-1",
            name: "scan.pdf",
            mime: "application/pdf",
            size: 123,
            position: 0,
          },
          degradation: { kind: "image" },
        }),
      /doesn't match/,
    );
  });
});

describe("assertPassThroughImageBytes", () => {
  test("accepts a decodable model-sized PNG", async () => {
    const bytes = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();

    await assert.doesNotReject(() => assertPassThroughImageBytes(bytes, "image/png"));
  });

  test("rejects tiny images before they can poison transcript history", async () => {
    const bytes = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    await assert.rejects(() => assertPassThroughImageBytes(bytes, "image/png"), /too small/);
  });

  test("rejects decoded images whose bytes don't match the declared MIME", async () => {
    const bytes = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    await assert.rejects(() => assertPassThroughImageBytes(bytes, "image/png"), /declared/);
  });
});

describe("validateStoredMeta", () => {
  // This is the send-time gate after collapsing assertStoredAttachmentReady to a
  // cheap HEAD (ADR-0065): /upload already decoded the bytes, so send-time only
  // needs to prove the stored object matches the declared payload. These are the
  // security-load-bearing branches — a forged turn payload must not pass.
  test("accepts a stored object that matches the declared size + type", () => {
    assert.doesNotThrow(() =>
      validateStoredMeta({
        stored: { size: 1234, contentType: "image/png" },
        declared: { mime: "image/png", size: 1234 },
      }),
    );
  });

  test("tolerates a stored content-type the provider omits on HEAD", () => {
    assert.doesNotThrow(() =>
      validateStoredMeta({
        stored: { size: 1234, contentType: "" },
        declared: { mime: "image/png", size: 1234 },
      }),
    );
  });

  test("normalizes a parametrized stored content-type before comparison", () => {
    assert.doesNotThrow(() =>
      validateStoredMeta({
        stored: { size: 10, contentType: "image/jpeg; charset=binary" },
        declared: { mime: "IMAGE/JPEG", size: 10 },
      }),
    );
  });

  test("rejects a size that doesn't match the sent message", () => {
    assert.throws(
      () =>
        validateStoredMeta({
          stored: { size: 999, contentType: "image/png" },
          declared: { mime: "image/png", size: 1234 },
        }),
      /size doesn't match/,
    );
  });

  test("rejects a stored type that doesn't match the declared MIME", () => {
    assert.throws(
      () =>
        validateStoredMeta({
          stored: { size: 1234, contentType: "image/webp" },
          declared: { mime: "image/png", size: 1234 },
        }),
      /type doesn't match/,
    );
  });
});
