import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachmentContentReferenceSchema } from "@alfred/contracts";

const validRef = {
  messageId: "msg-1",
  attachmentId: "att-1",
  threadId: "thr-1",
  accountId: "acc-1",
  filename: "resume.pdf",
  mimeType: "application/pdf",
  size: 1024,
  authoredAt: "2026-08-02T10:00:00.000Z",
};

describe("attachment content references", () => {
  test("the schema accepts a full writer entry", () => {
    assert.deepEqual(attachmentContentReferenceSchema.parse(validRef), validRef);
  });

  test("mimeType is optional for entries written before #878", () => {
    const { mimeType: _omitted, ...legacy } = validRef;
    assert.deepEqual(attachmentContentReferenceSchema.parse(legacy), legacy);
  });
});
