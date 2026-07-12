import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { NoObjectGeneratedError } from "ai";

import {
  chooseConversationSummaryModel,
  generateConversationSummary,
  type ConversationSummaryEvidence,
} from "../../src/modules/agent/compaction";

const evidence: ConversationSummaryEvidence = {
  priorSummary: null,
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
      {
        selectRoute: async () => "primary",
        run: async (args) => {
          prompt = args.prompt;
          return validSummary();
        },
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
        { selectRoute: async () => "primary", run: async () => fabricated },
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
        {
          selectRoute: async () => "primary",
          run: async () => {
            calls += 1;
            return validSummary();
          },
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
        {
          selectRoute: async () => "primary",
          run: async () => {
            calls += 1;
            return validSummary();
          },
        },
      ),
      /duplicate_source_id:msg_1/,
    );
    assert.equal(calls, 0);
  });

  test("retries malformed primary output once, then falls back", async () => {
    const routes: string[] = [];
    const summary = await generateConversationSummary(
      { evidence, attribution: { userId: "user_1" } },
      {
        selectRoute: async () => "primary",
        run: async ({ route }) => {
          routes.push(route);
          if (routes.length < 3) return { malformed: true };
          return validSummary();
        },
      },
    );
    assert.equal(summary.schemaVersion, 1);
    assert.deepEqual(routes, ["primary", "primary", "fallback"]);
  });

  test("a primary call failure skips directly to one fallback attempt", async () => {
    const routes: string[] = [];
    const summary = await generateConversationSummary(
      { evidence, attribution: { userId: "user_1" } },
      {
        selectRoute: async () => "primary",
        run: async ({ route }) => {
          routes.push(route);
          if (route === "primary") throw new Error("provider_unavailable");
          return validSummary();
        },
      },
    );
    assert.equal(summary.schemaVersion, 1);
    assert.deepEqual(routes, ["primary", "fallback"]);
  });

  test("AI SDK structured-output failures receive the one primary retry", async () => {
    const routes: string[] = [];
    await generateConversationSummary(
      { evidence, attribution: { userId: "user_1" } },
      {
        selectRoute: async () => "primary",
        run: async ({ route }) => {
          routes.push(route);
          if (routes.length === 1) {
            throw new NoObjectGeneratedError({
              message: "invalid structured output",
              text: "{}",
              response: { id: "response_1", timestamp: new Date(), modelId: "test" },
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
                outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
              },
              finishReason: "stop",
            });
          }
          return validSummary();
        },
      },
    );
    assert.deepEqual(routes, ["primary", "primary"]);
  });

  test("fit policy routes overflow to fallback and fails beyond both windows", () => {
    assert.equal(
      chooseConversationSummaryModel({
        inputTokens: 5_000,
        primaryWindowTokens: 10_000,
        fallbackWindowTokens: 20_000,
      }),
      "primary",
    );
    assert.equal(
      chooseConversationSummaryModel({
        inputTokens: 7_000,
        primaryWindowTokens: 10_000,
        fallbackWindowTokens: 20_000,
      }),
      "fallback",
    );
    assert.throws(
      () =>
        chooseConversationSummaryModel({
          inputTokens: 17_000,
          primaryWindowTokens: 10_000,
          fallbackWindowTokens: 20_000,
        }),
      /input_too_large/,
    );
  });
});
