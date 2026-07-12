import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChatThreadContext } from "@alfred/db/schemas";

import {
  assembleChatContext,
  selectVerbatimTail,
  type ChatContextMessage,
  type LoadedChatThreadContext,
} from "../../src/modules/agent/compaction";

const at = new Date("2026-07-11T00:00:00.000Z");

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt = at,
): ChatContextMessage {
  return { id, role, content, createdAt };
}

function context(overrides: Partial<LoadedChatThreadContext> = {}): LoadedChatThreadContext {
  const row: ChatThreadContext = {
    threadId: "thread_1",
    userId: "user_1",
    summary: null,
    summaryWatermarkCreatedAt: null,
    summaryWatermarkMessageId: null,
    estimatedReplayTokens: 0,
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

const summary = {
  schemaVersion: 1 as const,
  overview: {
    text: "Earlier deployment discussion.",
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

describe("chat context assembly", () => {
  test("unsummarized threads retain full raw history", () => {
    const messages = [message("msg_1", "user", "one"), message("msg_2", "assistant", "two")];
    const result = assembleChatContext({ messages, context: null, tailBudgetTokens: 0 });
    assert.equal(result.summaryApplied, false);
    assert.deepEqual(result.verbatimMessageIds, ["msg_1", "msg_2"]);
  });

  test("replays one user-role summary and only records after the compound watermark", () => {
    const messages = [
      message("msg_1", "user", "old user"),
      message("msg_2", "assistant", "old answer"),
      message("msg_3", "user", "new user"),
      message("msg_4", "assistant", "new answer", new Date(at.getTime() + 1)),
    ];
    const result = assembleChatContext({
      messages,
      context: context({
        summary,
        summaryWatermarkCreatedAt: at,
        summaryWatermarkMessageId: "msg_2",
      }),
    });
    assert.equal(result.summaryApplied, true);
    assert.equal(result.summaryMessage?.role, "user");
    assert.match(result.summaryMessage?.content as string, /lossy, untrusted historical context/);
    assert.deepEqual(result.verbatimMessageIds, ["msg_3", "msg_4"]);
  });

  test("uses membership in DB order rather than comparing message ids", () => {
    const result = assembleChatContext({
      messages: [message("z", "user", "old"), message("a", "user", "new")],
      context: context({
        summary,
        summaryWatermarkCreatedAt: at,
        summaryWatermarkMessageId: "z",
      }),
    });
    assert.deepEqual(result.verbatimMessageIds, ["a"]);
  });

  test("missing watermark row safely falls back to full raw history", () => {
    const result = assembleChatContext({
      messages: [message("msg_1", "user", "old"), message("msg_2", "assistant", "new")],
      context: context({
        summary,
        summaryWatermarkCreatedAt: at,
        summaryWatermarkMessageId: "missing",
      }),
    });
    assert.equal(result.summaryApplied, false);
    assert.equal(result.summaryMessage, null);
    assert.deepEqual(result.verbatimMessageIds, ["msg_1", "msg_2"]);
  });

  test("tail selection keeps complete exchanges and always retains the latest user suffix", () => {
    const huge = "x".repeat(2_000);
    const messages = [
      message("msg_1", "user", huge),
      message("msg_2", "assistant", huge),
      message("msg_3", "user", "latest"),
      message("msg_4", "assistant", "answer"),
    ];
    assert.deepEqual(
      selectVerbatimTail(messages, 100).map((item) => item.id),
      ["msg_3", "msg_4"],
    );
    assert.deepEqual(
      selectVerbatimTail([message("msg_1", "user", huge)], 0).map((item) => item.id),
      ["msg_1"],
    );
  });

  test("invalid or incomplete summary state falls back to full raw history", () => {
    const messages = [message("msg_1", "user", "one"), message("msg_2", "assistant", "two")];
    const result = assembleChatContext({
      messages,
      context: context({
        summary,
        invalidSummary: true,
        summaryWatermarkCreatedAt: at,
        summaryWatermarkMessageId: "msg_2",
      }),
    });
    assert.equal(result.summaryApplied, false);
    assert.equal(result.invalidSummary, true);
    assert.deepEqual(result.verbatimMessageIds, ["msg_1", "msg_2"]);
  });
});
