import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_ATTACHMENT_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from "@alfred/contracts";

import { assertAttachmentBatchAllowed } from "../../src/modules/chat/attachments";

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
