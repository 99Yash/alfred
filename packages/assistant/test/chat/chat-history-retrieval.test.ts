import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHAT_HISTORY_EXCERPT_CHARS,
  readChatHistory,
} from "@alfred/assistant/chat/chat-history-retrieval";
import type { ChatHistoryToolResult } from "@alfred/assistant/tool-runtime";

const at = new Date("2026-07-12T00:00:00.000Z");

/** The evidence of a found fetch. Any other result fails the test. */
function foundEvidence(result: ChatHistoryToolResult) {
  assert.ok(
    result.mode === "fetch" && result.ok && result.found,
    `expected a found fetch, got ${JSON.stringify(result)}`,
  );

  return result.result;
}

describe("current-thread chat history retrieval", () => {
  test("passes authenticated ownership scope to search and bounds results", async () => {
    let scope: unknown;

    const result = await readChatHistory(
      {
        userId: "user_1",
        threadId: "thread_1",
        input: { mode: "search", query: "deployment", limit: 2 },
      },
      {
        searchMessages: async (args) => {
          scope = args;

          return [
            { id: "m3", role: "assistant", content: "three", toolCalls: null, createdAt: at },
            { id: "m2", role: "user", content: "two", toolCalls: null, createdAt: at },
            { id: "m1", role: "user", content: "one", toolCalls: null, createdAt: at },
          ];
        },
      },
    );

    assert.deepEqual(scope, {
      userId: "user_1",
      threadId: "thread_1",
      query: "deployment",
      limit: 2,
    });
    assert.ok(result.mode === "search" && result.ok, "the search succeeds");
    assert.equal(result.results.length, 2);
  });

  test("returns explicit truncation metadata and strips NUL characters", async () => {
    const result = await readChatHistory(
      {
        userId: "user_1",
        threadId: "thread_1",
        input: { mode: "fetch", kind: "message", id: "m1" },
      },
      {
        fetchMessage: async () => ({
          id: "m1",
          role: "user",
          content: `safe\u0000${"x".repeat(CHAT_HISTORY_EXCERPT_CHARS + 20)}`,
          toolCalls: null,
          createdAt: at,
        }),
      },
    );

    const evidence = foundEvidence(result);
    assert.ok(evidence.kind === "message", "the fetch returns message evidence");
    const { content } = evidence;

    assert.equal(content.text.includes("\u0000"), false);
    assert.equal(content.text.length, CHAT_HISTORY_EXCERPT_CHARS);
    assert.equal(content.truncated, true);
  });

  test("fetches one sanitized tool outcome by stable id", async () => {
    const result = await readChatHistory(
      {
        userId: "user_1",
        threadId: "thread_1",
        input: { mode: "fetch", kind: "tool_call", id: "call_1" },
      },
      {
        fetchToolCall: async () => ({
          id: "m2",
          role: "assistant",
          content: "",
          createdAt: at,
          toolCalls: [
            {
              toolCallId: "call_1",
              toolName: "github.get_issue",
              status: "succeeded",
              argsPreview: '{"issue":485}',
              resultPreview: "done",
              sanitized: true,
            },
          ],
        }),
      },
    );

    const evidence = foundEvidence(result);
    assert.ok(evidence.kind === "tool_call", "the fetch returns tool-call evidence");
    assert.equal(evidence.id, "call_1");
    assert.equal(evidence.sanitized, true);
  });

  test("returns a bounded attachment representation without leaking its storage key", async () => {
    const result = await readChatHistory(
      {
        userId: "user_1",
        threadId: "thread_1",
        input: { mode: "fetch", kind: "attachment", id: "att_1" },
      },
      {
        fetchAttachment: async () => ({
          id: "att_1",
          messageId: "m1",
          name: "notes.pdf",
          mime: "application/pdf",
          status: "ready",
          degradedText: "Extracted notes",
          failureReason: null,
          createdAt: at,
          representation: {
            schemaVersion: 1,
            attachmentId: "att_1",
            messageId: "m1",
            mime: "application/pdf",
            visualDescription: null,
            ocrText: `Exact OCR ${"x".repeat(CHAT_HISTORY_EXCERPT_CHARS + 20)}`,
            salientEntities: [],
            evidence: [],
          },
        }),
      },
    );

    assert.equal(JSON.stringify(result).includes("storageKey"), false);
    const evidence = foundEvidence(result);
    assert.ok(evidence.kind === "attachment", "the fetch returns attachment evidence");
    assert.equal(evidence.messageId, "m1");

    const { representation } = evidence;
    assert.ok(representation, "the attachment carries a representation excerpt");

    assert.equal(representation.text.length, CHAT_HISTORY_EXCERPT_CHARS);
    assert.equal(representation.truncated, true);
    assert.ok(representation.originalChars > CHAT_HISTORY_EXCERPT_CHARS);
  });

  test("does not disclose whether an out-of-scope id exists", async () => {
    const result = await readChatHistory(
      {
        userId: "user_1",
        threadId: "thread_1",
        input: { mode: "fetch", kind: "message", id: "other_thread_message" },
      },
      { fetchMessage: async () => null },
    );

    assert.deepEqual(result, {
      ok: true,
      mode: "fetch",
      found: false,
      kind: "message",
      id: "other_thread_message",
    });
  });
});
