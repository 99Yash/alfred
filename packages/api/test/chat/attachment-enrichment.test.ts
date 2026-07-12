import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_ATTACHMENT_REPRESENTATION_VERSION,
  chatAttachmentRepresentationSchema,
  enrichClaimedChatAttachment,
  estimateAttachmentEnrichmentCostMicrousd,
  mediaModalityForMime,
  selectAttachmentsWithinEnrichmentBudget,
  shouldStartMediaEnrichment,
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

  test("starts proactively only above 80% of the background threshold", () => {
    assert.equal(shouldStartMediaEnrichment(80_000, 100_000), false);
    assert.equal(shouldStartMediaEnrichment(80_001, 100_000), true);
  });

  test("estimates a bounded scheduling cost from attachment size", () => {
    assert.equal(estimateAttachmentEnrichmentCostMicrousd(1), 20_000);
    assert.equal(estimateAttachmentEnrichmentCostMicrousd(2 * 1024 * 1024), 30_000);
  });

  test("persists one generated representation with server-owned provenance", async () => {
    let persisted: unknown;
    const result = await enrichClaimedChatAttachment(
      { attachmentId: "att_1", estimatedCostMicrousd: 12_000, attribution: { runId: "run_1" } },
      {
        loadAttachment: async () => ({
          id: "att_1",
          messageId: "msg_1",
          storageKey: "private/key",
          mime: "image/png",
          size: 10,
        }),
        readBytes: async () => new Uint8Array([1, 2, 3]),
        generate: async () => ({
          visualDescription: "A graph",
          ocrText: null,
          salientEntities: [],
          evidence: [],
        }),
        persist: async (args) => {
          persisted = args.representation;
          return true;
        },
      },
    );
    assert.equal(result, "persisted");
    assert.deepEqual(persisted, {
      schemaVersion: 1,
      attachmentId: "att_1",
      messageId: "msg_1",
      mime: "image/png",
      visualDescription: "A graph",
      ocrText: null,
      salientEntities: [],
      evidence: [],
    });
  });

  test("records a bounded failure category and rethrows", async () => {
    let category: string | undefined;
    await assert.rejects(
      enrichClaimedChatAttachment(
        { attachmentId: "att_1", estimatedCostMicrousd: 1, attribution: {} },
        {
          loadAttachment: async () => ({
            id: "att_1",
            messageId: "msg_1",
            storageKey: "key",
            mime: "image/png",
            size: 1,
          }),
          readBytes: async () => {
            throw new Error("bucket unavailable");
          },
          fail: async (_id, value) => {
            category = value;
            return true;
          },
        },
      ),
      /bucket unavailable/,
    );
    assert.equal(category, "generation_failed");
  });

  test("classifies supported MIME families and rejects unknown binaries", () => {
    assert.equal(mediaModalityForMime("application/pdf"), "pdf");
    assert.equal(mediaModalityForMime("video/mp4; codecs=h264"), "video");
    assert.throws(() => mediaModalityForMime("application/zip"), /unsupported/);
  });
});
