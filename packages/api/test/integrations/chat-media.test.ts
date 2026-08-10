import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createChatMediaHandler } from "../../src/composition/chat-media";
import {
  claimChatMediaEnrichment,
  cleanupChatMediaPrefix,
  cleanupPendingChatMediaUploads,
  enrichChatMedia,
  NoChatMediaHandlerRegisteredError,
  recordChatMediaEnqueueFailure,
  registerChatMediaHandler,
  type ChatMediaHandler,
} from "@alfred/assistant/connections/ingestion/chat-media";
import { enqueueChatAttachmentEnrichmentWith } from "@alfred/assistant/connections/ingestion/queue";
import { TriggerConsumerBootError } from "@alfred/assistant/triggers";

const enrichmentRequest = {
  userId: "user-1",
  attachmentId: "attachment-1",
  estimatedCostMicrousd: 42,
};

function handlerFixture(overrides: Partial<ChatMediaHandler> = {}): ChatMediaHandler {
  return {
    async claimEnrichment() {
      return "claimed";
    },
    async recordEnqueueFailure() {},
    async enrich() {
      return "persisted";
    },
    async cleanupPrefix() {
      return { removed: 0 };
    },
    async cleanupPendingUploads(request) {
      return { checked: request.keys.length, removed: 0 };
    },
    ...overrides,
  };
}

describe("chat media composition seam", () => {
  test("validates each exact operation request and result", async () => {
    const received: string[] = [];
    const unregister = registerChatMediaHandler(
      handlerFixture({
        async claimEnrichment(request) {
          received.push(`claim:${request.attachmentId}`);
          return "claimed";
        },
        async recordEnqueueFailure(request) {
          received.push(`fail:${request.attachmentId}`);
        },
        async enrich(request) {
          received.push(`enrich:${request.attachmentId}`);
          return "persisted";
        },
        async cleanupPrefix(request) {
          received.push(`prefix:${request.prefix}`);
          return { removed: 2 };
        },
        async cleanupPendingUploads(request) {
          received.push(`pending:${request.keys.length}`);
          return { checked: request.keys.length, removed: 1 };
        },
      }),
    );

    try {
      assert.equal(await claimChatMediaEnrichment({ attachmentId: "attachment-1" }), "claimed");
      await recordChatMediaEnqueueFailure({ attachmentId: "attachment-1" });
      assert.equal(await enrichChatMedia(enrichmentRequest), "persisted");
      assert.deepEqual(
        await cleanupChatMediaPrefix({
          userId: "user-1",
          prefix: "chat/user-1/thread-1/",
        }),
        { removed: 2 },
      );
      assert.deepEqual(
        await cleanupPendingChatMediaUploads({ userId: "user-1", keys: ["kept", "orphaned"] }),
        { checked: 2, removed: 1 },
      );
      assert.deepEqual(received, [
        "claim:attachment-1",
        "fail:attachment-1",
        "enrich:attachment-1",
        "prefix:chat/user-1/thread-1/",
        "pending:2",
      ]);
    } finally {
      unregister();
    }
  });

  test("rejects invalid operation requests and invalid adapter results", async () => {
    const invalidHandler = handlerFixture({
      async enrich() {
        return { removed: 1 };
      },
    } as unknown as Partial<ChatMediaHandler>);
    const unregister = registerChatMediaHandler(invalidHandler);
    try {
      await assert.rejects(() =>
        enrichChatMedia({ ...enrichmentRequest, estimatedCostMicrousd: -1 }),
      );
      await assert.rejects(() =>
        cleanupChatMediaPrefix({
          userId: "user-1",
          prefix: "x".repeat(2_001),
        }),
      );
      await assert.rejects(() => enrichChatMedia(enrichmentRequest));
    } finally {
      unregister();
    }
  });

  test("rejects missing runtime composition", async () => {
    await assert.rejects(
      () => claimChatMediaEnrichment({ attachmentId: "attachment-1" }),
      NoChatMediaHandlerRegisteredError,
    );
    await assert.rejects(
      () => enrichChatMedia(enrichmentRequest),
      NoChatMediaHandlerRegisteredError,
    );
  });

  // Backstop for the boot-error-plain-extends gate: if the seam ever reaches this
  // registry's not-registered error from a best-effort consumer, membership in
  // TriggerConsumerBootError is what makes it reject the publish rather than be
  // swallowed. Catches a revert to `extends Error` even if the static gate were removed.
  test("its not-registered error is a TriggerConsumerBootError", () => {
    assert.ok(new NoChatMediaHandlerRegisteredError() instanceof TriggerConsumerBootError);
  });

  test("queue transport cannot bypass claim and records enqueue failure", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        enqueueChatAttachmentEnrichmentWith(
          {
            async claim(attachmentId) {
              calls.push(`claim:${attachmentId}`);
              return "claimed";
            },
            async enqueue(request) {
              calls.push(`enqueue:${request.attachmentId}`);
              throw new Error("redis unavailable");
            },
            async recordEnqueueFailure(attachmentId) {
              calls.push(`fail:${attachmentId}`);
            },
          },
          enrichmentRequest,
        ),
      /redis unavailable/,
    );
    assert.deepEqual(calls, ["claim:attachment-1", "enqueue:attachment-1", "fail:attachment-1"]);
  });

  test("queue transport does not enqueue an existing enrichment", async () => {
    let enqueues = 0;
    const result = await enqueueChatAttachmentEnrichmentWith(
      {
        async claim() {
          return "existing";
        },
        async enqueue() {
          enqueues++;
        },
        async recordEnqueueFailure() {},
      },
      enrichmentRequest,
    );
    assert.equal(result, "existing");
    assert.equal(enqueues, 0);
  });

  test("preserves enrichment attribution and result", async () => {
    let received: unknown;
    const handler = createChatMediaHandler({
      async enrich(args) {
        received = args;
        return "superseded";
      },
    });

    assert.equal(await handler.enrich(enrichmentRequest), "superseded");
    assert.deepEqual(received, {
      attachmentId: "attachment-1",
      estimatedCostMicrousd: 42,
      attribution: {
        userId: "user-1",
        idempotencyKey: "media-enrich:attachment-1",
        name: "chat.attachment-enrichment.background",
      },
    });
  });

  test("keeps cleanup a no-op when storage is not configured", async () => {
    let deletes = 0;
    const handler = createChatMediaHandler({
      storageConfigured() {
        return false;
      },
      async deletePrefix() {
        deletes++;
        return 1;
      },
      async cleanupPendingUploads() {
        deletes++;
        return 1;
      },
    });

    assert.deepEqual(await handler.cleanupPrefix({ userId: "user-1", prefix: "chat/user-1/" }), {
      removed: 0,
      skipped: "storage-unconfigured",
    });
    assert.deepEqual(
      await handler.cleanupPendingUploads({ userId: "user-1", keys: ["kept", "orphaned"] }),
      { removed: 0, skipped: "storage-unconfigured" },
    );
    assert.equal(deletes, 0);
  });

  test("delegates pending cleanup as one coordinated operation", async () => {
    let received: unknown;
    const handler = createChatMediaHandler({
      storageConfigured() {
        return true;
      },
      async cleanupPendingUploads(request) {
        received = request;
        return 1;
      },
    });

    assert.deepEqual(
      await handler.cleanupPendingUploads({
        userId: "user-1",
        keys: ["kept", "orphaned"],
      }),
      { checked: 2, removed: 1 },
    );
    assert.deepEqual(received, { userId: "user-1", keys: ["kept", "orphaned"] });
  });
});
