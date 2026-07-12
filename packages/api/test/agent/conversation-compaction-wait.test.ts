import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChatThreadContext } from "@alfred/db/schemas";

import {
  isCompactionActive,
  waitForActiveConversationCompaction,
  type ConversationSummary,
  type LoadedChatThreadContext,
} from "../../src/modules/agent/compaction";

const at = new Date("2026-07-12T00:00:00.000Z");
const summary: ConversationSummary = {
  schemaVersion: 1,
  overview: { text: "Summary", sourceMessageRange: { fromMessageId: "m1", toMessageId: "m2" } },
  facts: [],
  preferences: [],
  instructions: [],
  decisions: [],
  actionOutcomes: [],
  unresolvedQuestions: [],
  importantEntities: [],
};

function context(overrides: Partial<LoadedChatThreadContext> = {}): LoadedChatThreadContext {
  const row: ChatThreadContext = {
    threadId: "thread_1",
    userId: "user_1",
    summary: null,
    summaryWatermarkCreatedAt: null,
    summaryWatermarkMessageId: null,
    estimatedReplayTokens: 0,
    compactionRequestedAt: at,
    compactionCompletedAt: null,
    compactionFailedAt: null,
    compactionFailureCategory: null,
    compactionFailureMessage: null,
    compactionGeneration: 1,
    createdAt: at,
    updatedAt: at,
  };
  return { ...row, invalidSummary: false, ...overrides };
}

describe("foreground background-compaction reuse", () => {
  test("recognizes only requests newer than both completion and failure", () => {
    assert.equal(isCompactionActive(context()), true);
    assert.equal(isCompactionActive(context({ compactionCompletedAt: at })), false);
    assert.equal(isCompactionActive(context({ compactionFailedAt: at })), false);
    assert.equal(isCompactionActive(null), false);
  });

  test("returns a newer valid generation without starting foreground work", async () => {
    let clock = 0;
    let reads = 0;
    const winner = context({
      summary,
      compactionGeneration: 2,
      compactionCompletedAt: new Date(at.getTime() + 1),
    });
    const result = await waitForActiveConversationCompaction("user_1", "thread_1", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      loadContext: async () => (++reads === 1 ? context() : winner),
    });
    assert.equal(result, winner);
    assert.equal(clock, 50);
  });

  test("times out after 500 ms when the active generation does not advance", async () => {
    let clock = 0;
    const result = await waitForActiveConversationCompaction("user_1", "thread_1", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      loadContext: async () => context(),
    });
    assert.equal(result, null);
    assert.equal(clock, 500);
  });
});
