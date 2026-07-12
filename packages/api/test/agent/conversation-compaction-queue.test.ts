import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  enqueueConversationCompaction,
  isUnrecoverableConversationCompactionError,
} from "../../src/modules/agent/compaction";

const at = new Date("2026-07-12T00:00:00.000Z");
const args = {
  userId: "user_1",
  threadId: "thread:1",
  throughWatermark: { messageId: "msg_1", createdAt: at },
  replayTailWatermark: { messageId: "msg_3", createdAt: at },
  replayTail: [{ role: "user" as const, content: "latest" }],
};

describe("conversation compaction queue", () => {
  test("classifies deterministic evidence failures as non-retryable", () => {
    assert.equal(
      isUnrecoverableConversationCompactionError(
        new Error("conversation_summary_invalid_provenance: message:invented"),
      ),
      true,
    );
    assert.equal(
      isUnrecoverableConversationCompactionError(
        new Error("conversation_summary_watermark_not_loaded"),
      ),
      true,
    );
    assert.equal(
      isUnrecoverableConversationCompactionError(new Error("provider overloaded")),
      false,
    );
  });

  test("does no queue or database work when queues are disabled", async () => {
    let touched = false;
    const result = await enqueueConversationCompaction(args, {
      enabled: () => false,
      getExisting: async () => {
        touched = true;
        return undefined;
      },
    });
    assert.equal(result, "disabled");
    assert.equal(touched, false);
  });

  for (const state of ["active", "waiting", "delayed"] as const) {
    test(`deduplicates an ${state} job without advancing the generation`, async () => {
      let marked = false;
      const result = await enqueueConversationCompaction(args, {
        enabled: () => true,
        getExisting: async () => ({ state, remove: async () => undefined }),
        markRequested: async () => {
          marked = true;
          return { requestedAt: at, generation: 1 };
        },
      });
      assert.equal(result, "deduplicated");
      assert.equal(marked, false);
    });
  }

  test("replaces a terminal job and enqueues the complete bounded request", async () => {
    let removed = false;
    let added: { jobId: string; data: unknown } | undefined;
    const result = await enqueueConversationCompaction(args, {
      enabled: () => true,
      getExisting: async () => ({
        state: "completed",
        remove: async () => {
          removed = true;
        },
      }),
      markRequested: async () => ({ requestedAt: at, generation: 4 }),
      add: async (jobId, data) => {
        added = { jobId, data };
      },
    });
    assert.equal(result, "scheduled");
    assert.equal(removed, true);
    assert.equal(added?.jobId, "conversation-compact.thread.1");
    assert.deepEqual(added?.data, {
      kind: "conversation.compact",
      userId: "user_1",
      threadId: "thread:1",
      throughMessageId: "msg_1",
      throughCreatedAt: at.toISOString(),
      replayTailThroughMessageId: "msg_3",
      replayTailThroughCreatedAt: at.toISOString(),
      requestedAt: at.toISOString(),
      expectedGeneration: 4,
      replayTail: args.replayTail,
    });
  });

  test("records enqueue failure against the exact request generation and rethrows", async () => {
    let failure: { expectedGeneration: number; category: string } | undefined;
    await assert.rejects(
      enqueueConversationCompaction(args, {
        enabled: () => true,
        getExisting: async () => undefined,
        markRequested: async () => ({ requestedAt: at, generation: 7 }),
        add: async () => {
          throw new Error("redis unavailable");
        },
        recordFailure: async (value) => {
          failure = value;
          return true;
        },
      }),
      /redis unavailable/,
    );
    assert.equal(failure?.expectedGeneration, 7);
    assert.equal(failure?.category, "enqueue_failed");
  });
});
