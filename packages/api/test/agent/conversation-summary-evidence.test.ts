import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChatAttachment, ChatMessage } from "@alfred/db/schemas";

import {
  buildConversationSummaryEvidence,
  eligibleConversationSummarySources,
  CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS,
} from "../../src/modules/agent/compaction";

const at = new Date("2026-07-12T00:00:00.000Z");

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg_2",
    userId: "user_1",
    threadId: "thread_1",
    role: "assistant",
    content: "Build failed.",
    reasoning: null,
    reasoningMs: null,
    status: "complete",
    errorKind: null,
    toolCalls: null,
    narration: null,
    runId: "run_1",
    rowVersion: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function attachment(overrides: Partial<ChatAttachment>): ChatAttachment {
  return {
    id: "att_1",
    userId: "user_1",
    messageId: "msg_2",
    storageKey: "private/key",
    name: "build.log",
    mime: "text/plain",
    size: 10,
    position: 0,
    status: "ready",
    degradedText: "compiler output",
    degradedImageKeys: [],
    failureReason: null,
    rowVersion: 0,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe("conversation summary evidence", () => {
  test("maps persisted outcomes and attachment artifacts without storage secrets", () => {
    const evidence = buildConversationSummaryEvidence({
      priorSummary: null,
      messages: [
        message({
          toolCalls: [
            {
              toolCallId: "tool_1",
              toolName: "railway.deploy",
              status: "failed",
              argsPreview: "staging",
              resultPreview: "build failed",
            },
          ],
        }),
      ],
      attachments: [attachment({})],
    });
    assert.equal(evidence.tools[0]?.id, "tool_1");
    assert.deepEqual(evidence.tools[0]?.content, {
      messageId: "msg_2",
      name: "railway.deploy",
      status: "failed",
      args: "staging",
      result: "build failed",
      sanitized: false,
    });
    assert.equal(evidence.attachments[0]?.id, "att_1");
    assert.doesNotMatch(JSON.stringify(evidence), /private\/key/);
  });

  test("bounds authored and extracted text per evidence record", () => {
    const evidence = buildConversationSummaryEvidence({
      priorSummary: null,
      messages: [message({ content: "x".repeat(CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS + 1) })],
      attachments: [
        attachment({ degradedText: "y".repeat(CONVERSATION_EVIDENCE_TEXT_LIMIT_CHARS + 1) }),
      ],
    });
    assert.match(JSON.stringify(evidence.messages[0]?.content), /\[truncated\]/);
    assert.match(JSON.stringify(evidence.attachments[0]?.content), /\[truncated\]/);
  });

  test("retains prior validated citations as eligible for a replacement summary", () => {
    const priorSummary = {
      schemaVersion: 1 as const,
      overview: {
        text: "Prior context.",
        sourceMessageRange: { fromMessageId: "msg_0", toMessageId: "msg_1" },
      },
      facts: [{ text: "Known fact", sources: [{ kind: "attachment" as const, id: "att_old" }] }],
      preferences: [],
      instructions: [],
      decisions: [],
      actionOutcomes: [],
      unresolvedQuestions: [],
      importantEntities: [],
    };
    const evidence = buildConversationSummaryEvidence({
      priorSummary,
      messages: [message({ id: "msg_2" })],
      attachments: [],
    });
    const eligible = eligibleConversationSummarySources(evidence);
    assert.equal(eligible.messageIds.has("msg_0"), true);
    assert.equal(eligible.messageIds.has("msg_1"), true);
    assert.equal(eligible.messageIds.has("msg_2"), true);
    assert.equal(eligible.attachmentIds.has("att_old"), true);
  });
});
