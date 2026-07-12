import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_ATTACHMENT_REPRESENTATION_VERSION,
  chatAttachmentRepresentationSchema,
  selectAttachmentsWithinEnrichmentBudget,
} from "../../src/modules/chat/attachment-enrichment";

describe("chat attachment enrichment", () => {
  test("validates one versioned representation with attachment and message provenance", () => {
    const parsed = chatAttachmentRepresentationSchema.parse({
      schemaVersion: CHAT_ATTACHMENT_REPRESENTATION_VERSION,
      attachmentId: "att_1",
      messageId: "msg_1",
      mime: "image/png",
      visualDescription: "A deployment graph",
      ocrText: "Error rate 12%",
      salientEntities: ["production", "api"],
      evidence: [{ kind: "chart", text: "Error rate rises after 14:00" }],
    });
    assert.equal(parsed.attachmentId, "att_1");
  });

  test("rejects unversioned or over-broad representations", () => {
    assert.equal(
      chatAttachmentRepresentationSchema.safeParse({
        schemaVersion: 2,
        attachmentId: "att_1",
        messageId: "msg_1",
        mime: "image/png",
        visualDescription: null,
        ocrText: null,
        salientEntities: [],
        evidence: [],
      }).success,
      false,
    );
  });

  test("selects prioritized candidates without exceeding the cycle budget", () => {
    const selected = selectAttachmentsWithinEnrichmentBudget(
      [
        { id: "nearby", estimatedCostMicrousd: 300_000 },
        { id: "too_expensive", estimatedCostMicrousd: 300_000 },
        { id: "small", estimatedCostMicrousd: 150_000 },
      ],
      500_000,
    );
    assert.deepEqual(
      selected.map((item) => item.id),
      ["nearby", "small"],
    );
  });
});
