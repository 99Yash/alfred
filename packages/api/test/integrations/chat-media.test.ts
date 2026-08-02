import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createChatMediaHandler } from "../../src/composition/chat-media";
import {
  chatAttachmentEnrichmentScheduleRequestSchema,
  chatMediaJobRequestSchema,
  NoChatMediaHandlerRegisteredError,
  processChatMediaJob,
  registerChatMediaHandler,
  scheduleChatAttachmentEnrichment,
  type ChatMediaHandler,
} from "../../src/modules/integrations/chat-media";

const scheduleRequest = {
  userId: "user-1",
  attachmentId: "attachment-1",
  estimatedCostMicrousd: 42,
};

describe("chat media composition seam", () => {
  test("owns strict bounded request schemas", () => {
    assert.equal(
      chatAttachmentEnrichmentScheduleRequestSchema.safeParse(scheduleRequest).success,
      true,
    );
    assert.equal(
      chatAttachmentEnrichmentScheduleRequestSchema.safeParse({
        ...scheduleRequest,
        unexpected: true,
      }).success,
      false,
    );
    assert.equal(
      chatAttachmentEnrichmentScheduleRequestSchema.safeParse({
        ...scheduleRequest,
        estimatedCostMicrousd: -1,
      }).success,
      false,
    );
    assert.equal(
      chatMediaJobRequestSchema.safeParse({
        kind: "cleanup-pending-uploads",
        userId: "user-1",
        keys: [],
      }).success,
      true,
    );
    assert.equal(
      chatMediaJobRequestSchema.safeParse({
        kind: "cleanup-prefix",
        userId: "user-1",
        prefix: "x".repeat(2_001),
      }).success,
      false,
    );
  });

  test("validates requests and the result for the selected job kind", async () => {
    const received: unknown[] = [];
    const unregister = registerChatMediaHandler({
      async scheduleEnrichment(request) {
        received.push(request);
        return "scheduled";
      },
      async processJob(request) {
        received.push(request);
        return request.kind === "enrich" ? "persisted" : { removed: 2 };
      },
    });

    try {
      assert.equal(await scheduleChatAttachmentEnrichment(scheduleRequest), "scheduled");
      assert.equal(await processChatMediaJob({ kind: "enrich", ...scheduleRequest }), "persisted");
      assert.deepEqual(
        await processChatMediaJob({
          kind: "cleanup-prefix",
          userId: "user-1",
          prefix: "chat/user-1/thread-1/",
        }),
        { removed: 2 },
      );
      assert.equal(received.length, 3);
    } finally {
      unregister();
    }

    const invalidHandler = {
      async scheduleEnrichment() {
        return "unexpected";
      },
      async processJob() {
        return { checked: 1, removed: 1 };
      },
    } as unknown as ChatMediaHandler;
    const unregisterInvalid = registerChatMediaHandler(invalidHandler);
    try {
      await assert.rejects(() => scheduleChatAttachmentEnrichment(scheduleRequest));
      await assert.rejects(() =>
        processChatMediaJob({
          kind: "cleanup-prefix",
          userId: "user-1",
          prefix: "chat/user-1/",
        }),
      );
    } finally {
      unregisterInvalid();
    }
  });

  test("rejects missing runtime composition", async () => {
    await assert.rejects(
      () => scheduleChatAttachmentEnrichment(scheduleRequest),
      NoChatMediaHandlerRegisteredError,
    );
    await assert.rejects(
      () => processChatMediaJob({ kind: "enrich", ...scheduleRequest }),
      NoChatMediaHandlerRegisteredError,
    );
  });

  test("claims before enqueue and marks a claimed attachment when enqueue fails", async () => {
    const calls: string[] = [];
    const handler = createChatMediaHandler({
      async claimEnrichment(attachmentId) {
        calls.push(`claim:${attachmentId}`);
        return "claimed";
      },
      async enqueueEnrichmentJob(request) {
        calls.push(`enqueue:${request.attachmentId}`);
        throw new Error("redis unavailable");
      },
      async recordEnqueueFailure(attachmentId) {
        calls.push(`fail:${attachmentId}`);
      },
    });

    await assert.rejects(() => handler.scheduleEnrichment(scheduleRequest), /redis unavailable/);
    assert.deepEqual(calls, ["claim:attachment-1", "enqueue:attachment-1", "fail:attachment-1"]);
  });

  test("does not enqueue an existing enrichment", async () => {
    let enqueues = 0;
    const handler = createChatMediaHandler({
      async claimEnrichment() {
        return "existing";
      },
      async enqueueEnrichmentJob() {
        enqueues++;
      },
    });

    assert.equal(await handler.scheduleEnrichment(scheduleRequest), "existing");
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

    assert.equal(await handler.processJob({ kind: "enrich", ...scheduleRequest }), "superseded");
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
      async loadRetainedKeys() {
        deletes++;
        return [];
      },
      async deleteObjects() {
        deletes++;
        return 1;
      },
    });

    assert.deepEqual(
      await handler.processJob({
        kind: "cleanup-prefix",
        userId: "user-1",
        prefix: "chat/user-1/",
      }),
      { removed: 0, skipped: "storage-unconfigured" },
    );
    assert.deepEqual(
      await handler.processJob({
        kind: "cleanup-pending-uploads",
        userId: "user-1",
        keys: ["kept", "orphaned"],
      }),
      { removed: 0, skipped: "storage-unconfigured" },
    );
    assert.equal(deletes, 0);
  });

  test("deletes only pending-upload keys without a durable attachment row", async () => {
    let deleted: readonly string[] = [];
    const handler = createChatMediaHandler({
      storageConfigured() {
        return true;
      },
      async loadRetainedKeys(keys) {
        assert.deepEqual(keys, ["kept", "orphaned"]);
        return ["kept"];
      },
      async deleteObjects(keys) {
        deleted = keys;
        return keys.length;
      },
    });

    assert.deepEqual(
      await handler.processJob({
        kind: "cleanup-pending-uploads",
        userId: "user-1",
        keys: ["kept", "orphaned"],
      }),
      { checked: 2, removed: 1 },
    );
    assert.deepEqual(deleted, ["orphaned"]);
  });
});
