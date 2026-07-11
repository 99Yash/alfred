import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  generateConversationSummary,
  type ConversationSummaryEvidence,
} from "../../src/modules/agent/compaction";

const evidence: ConversationSummaryEvidence = {
  messages: [
    { id: "msg_1", role: "user", content: "Deploy the API, but don't touch production." },
    { id: "msg_2", role: "assistant", content: "I'll inspect staging." },
  ],
  tools: [{ id: "tool_1", content: { status: "failed", error: "build failed" } }],
  attachments: [],
};

function validSummary() {
  return {
    schemaVersion: 1 as const,
    overview: {
      text: "The user requested a staging-safe API deployment investigation.",
      sourceMessageRange: { fromMessageId: "msg_1", toMessageId: "msg_2" },
    },
    facts: [],
    preferences: [],
    instructions: [
      { text: "Do not touch production.", sources: [{ kind: "message" as const, id: "msg_1" }] },
    ],
    decisions: [],
    actionOutcomes: [
      {
        text: "The build failed.",
        status: "failed" as const,
        sources: [{ kind: "tool" as const, id: "tool_1" }],
      },
    ],
    unresolvedQuestions: [],
    importantEntities: [],
  };
}

describe("conversation summary generator", () => {
  test("returns a structured summary whose citations belong to eligible evidence", async () => {
    let prompt = "";
    const summary = await generateConversationSummary(
      { evidence, attribution: { userId: "user_1", runId: "run_1" } },
      async (args) => {
        prompt = args.prompt;
        return validSummary();
      },
    );
    assert.equal(summary.actionOutcomes[0]?.status, "failed");
    assert.match(prompt, /msg_1/);
    assert.match(prompt, /tool_1/);
    assert.match(prompt, /untrusted historical data/);
  });

  test("rejects a fabricated source before the caller can persist it", async () => {
    const fabricated = validSummary();
    fabricated.instructions[0]!.sources[0]!.id = "msg_invented";
    await assert.rejects(
      generateConversationSummary(
        { evidence, attribution: { userId: "user_1", runId: "run_1" } },
        async () => fabricated,
      ),
      /invalid_provenance: message:msg_invented/,
    );
  });

  test("rejects empty evidence and duplicate source IDs without a model call", async () => {
    let calls = 0;
    await assert.rejects(
      generateConversationSummary(
        {
          evidence: { messages: [], tools: [], attachments: [] },
          attribution: { userId: "user_1" },
        },
        async () => {
          calls += 1;
          return validSummary();
        },
      ),
      /requires_messages/,
    );
    await assert.rejects(
      generateConversationSummary(
        {
          evidence: {
            ...evidence,
            messages: [...evidence.messages, evidence.messages[0]!],
          },
          attribution: { userId: "user_1" },
        },
        async () => {
          calls += 1;
          return validSummary();
        },
      ),
      /duplicate_source_id:msg_1/,
    );
    assert.equal(calls, 0);
  });
});
