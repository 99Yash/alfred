import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CHAT_HISTORY_EXCERPT_CHARS, readChatHistory } from "../../src/modules/agent/compaction";

const at = new Date("2026-07-12T00:00:00.000Z");

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
    assert.equal((result as { results: unknown[] }).results.length, 2);
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
    const content = (result as { result: { content: { text: string; truncated: boolean } } }).result
      .content;
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
    assert.equal((result as { result: { id: string; sanitized: boolean } }).result.id, "call_1");
    assert.equal((result as { result: { sanitized: boolean } }).result.sanitized, true);
  });

  test("returns attachment representation without leaking its storage key", async () => {
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
            ocrText: "Exact OCR",
            salientEntities: [],
            evidence: [],
          },
        }),
      },
    );
    assert.equal(JSON.stringify(result).includes("storageKey"), false);
    assert.equal((result as { result: { messageId: string } }).result.messageId, "m1");
    assert.equal(
      (result as { result: { representation: { ocrText: string } } }).result.representation.ocrText,
      "Exact OCR",
    );
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
