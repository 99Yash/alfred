import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_ATTACHMENT_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";
import sharp from "sharp";

import {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
} from "../../src/modules/chat/attachments";

describe("assertAttachmentBatchAllowed", () => {
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
