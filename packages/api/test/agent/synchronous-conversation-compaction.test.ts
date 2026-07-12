import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChatThreadContext } from "@alfred/db/schemas";

import {
  compactConversationSynchronously,
  conversationSummaryMessage,
  estimateTranscriptTokens,
  type ConversationSummary,
  type LoadedChatThreadContext,
  type PersistConversationSummaryArgs,
} from "../../src/modules/agent/compaction";

const at = new Date("2026-07-12T00:00:00.000Z");
const watermark = { createdAt: at, messageId: "msg_2" };
const summary: ConversationSummary = {
  schemaVersion: 1,
  overview: {
    text: "Deployment investigation.",
    sourceMessageRange: { fromMessageId: "msg_1", toMessageId: "msg_2" },
  },
  facts: [],
  preferences: [],
  instructions: [],
  decisions: [],
  actionOutcomes: [],
  unresolvedQuestions: [],
  importantEntities: [],
};

const evidence = {
  priorSummary: null,
  messages: [
    { id: "msg_1", role: "user" as const, content: "Deploy staging" },
    { id: "msg_2", role: "assistant" as const, content: "Investigating" },
  ],
  tools: [],
  attachments: [],
};

function context(overrides: Partial<LoadedChatThreadContext> = {}): LoadedChatThreadContext {
  const row: ChatThreadContext = {
    threadId: "thread_1",
    userId: "user_1",
    summary: null,
    summaryWatermarkCreatedAt: null,
    summaryWatermarkMessageId: null,
    estimatedReplayTokens: 0,
    replayEstimateWatermarkCreatedAt: null,
    replayEstimateWatermarkMessageId: null,
    compactionRequestedAt: null,
    compactionCompletedAt: null,
    compactionFailedAt: null,
    compactionFailureCategory: null,
    compactionFailureMessage: null,
    compactionGeneration: 0,
    createdAt: at,
    updatedAt: at,
  };
  return { ...row, invalidSummary: false, ...overrides };
}

describe("synchronous conversation compaction", () => {
  test("generates a replacement and persists the exact replay estimate", async () => {
    let persistedArgs: PersistConversationSummaryArgs | null = null;
    const replayTail = [{ role: "user" as const, content: "latest question" }];
    const result = await compactConversationSynchronously(
      {
        userId: "user_1",
        threadId: "thread_1",
        throughWatermark: watermark,
        replayTail,
        replayTailWatermark: { createdAt: at, messageId: "msg_latest" },
        attribution: { runId: "run_1" },
      },
      {
        loadContext: async () => null,
        loadEvidence: async () => ({ evidence, watermark }),
        generateSummary: async () => summary,
        persistSummary: async (args) => {
          persistedArgs = args;
          return true;
        },
      },
    );
    const expectedTokens = estimateTranscriptTokens([
      conversationSummaryMessage(summary),
      ...replayTail,
    ]);
    assert.equal(result.kind, "persisted");
    assert.equal(result.kind === "persisted" ? result.estimatedReplayTokens : -1, expectedTokens);
    assert.equal(persistedArgs?.estimatedReplayTokens, expectedTokens);
    assert.equal(persistedArgs?.expectedGeneration, 0);
    assert.equal(persistedArgs?.expectedWatermark, null);
  });

  test("an invalid persisted summary rebuilds from raw history but CAS-checks its old state", async () => {
    const staleWatermark = { createdAt: at, messageId: "msg_old" };
    let loadedAfter: typeof staleWatermark | null | undefined;
    let persistedArgs: PersistConversationSummaryArgs | null = null;
    await compactConversationSynchronously(
      {
        userId: "user_1",
        threadId: "thread_1",
        throughWatermark: watermark,
        replayTail: [],
        replayTailWatermark: watermark,
        attribution: {},
      },
      {
        loadContext: async () =>
          context({
            invalidSummary: true,
            compactionGeneration: 3,
            summaryWatermarkCreatedAt: staleWatermark.createdAt,
            summaryWatermarkMessageId: staleWatermark.messageId,
          }),
        loadEvidence: async (args) => {
          loadedAfter = args.afterWatermark;
          assert.equal(args.priorSummary, null);
          return { evidence, watermark };
        },
        generateSummary: async () => summary,
        persistSummary: async (args) => {
          persistedArgs = args;
          return true;
        },
      },
    );
    assert.equal(loadedAfter, null);
    assert.equal(persistedArgs?.expectedGeneration, 3);
    assert.deepEqual(persistedArgs?.expectedWatermark, staleWatermark);
  });

  test("reports a losing compare-and-swap without claiming persistence", async () => {
    const result = await compactConversationSynchronously(
      {
        userId: "user_1",
        threadId: "thread_1",
        throughWatermark: watermark,
        replayTail: [],
        replayTailWatermark: watermark,
        attribution: {},
      },
      {
        loadContext: async () => null,
        loadEvidence: async () => ({ evidence, watermark }),
        generateSummary: async () => summary,
        persistSummary: async () => false,
      },
    );
    assert.deepEqual(result, { kind: "superseded" });
  });

  test("threads foreground cancellation and timeout through summary generation", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let receivedTimeout: number | undefined;
    await compactConversationSynchronously(
      {
        userId: "user_1",
        threadId: "thread_1",
        throughWatermark: watermark,
        replayTail: [],
        replayTailWatermark: watermark,
        attribution: {},
        abortSignal: controller.signal,
        timeoutMs: 1234,
      },
      {
        loadContext: async () => null,
        loadEvidence: async () => ({ evidence, watermark }),
        generateSummary: async (args) => {
          receivedSignal = args.abortSignal;
          receivedTimeout = args.timeoutMs;
          return summary;
        },
        persistSummary: async () => true,
      },
    );

    assert.equal(receivedSignal, controller.signal);
    assert.equal(receivedTimeout, 1234);
  });
});
