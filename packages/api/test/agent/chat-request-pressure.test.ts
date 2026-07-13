import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";

import {
  assessChatRequestPressure,
  estimateChatRequestTokens,
  CHAT_HYDRATED_IMAGE_TOKENS,
} from "../../src/modules/agent/compaction";

const tools = {
  lookup: tool({
    description: "Look up a record by its stable identifier.",
    inputSchema: z.object({ id: z.string().describe("Stable record identifier") }),
  }),
} satisfies ToolSet;

describe("chat request pressure", () => {
  test("counts system prompt, canonical tool schemas, transcript, and output reserve", async () => {
    const base = await estimateChatRequestTokens({
      systemPrompt: "system",
      tools: {},
      transcript: [{ role: "user", content: "hello" }],
      outputReserveTokens: 16_000,
    });
    const composed = await estimateChatRequestTokens({
      systemPrompt: "system with more grounding",
      tools,
      transcript: [{ role: "user", content: "hello with a longer transcript" }],
      outputReserveTokens: 16_000,
    });
    assert.ok(composed.systemTokens > base.systemTokens);
    assert.ok(composed.toolTokens > base.toolTokens);
    assert.ok(composed.transcriptTokens > base.transcriptTokens);
    assert.equal(composed.totalRequestTokens, composed.inputTokens + 16_000);
  });

  test("counts hydrated images without treating base64 transport bytes as text", async () => {
    const transcript: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "file", data: "a".repeat(1_000_000), mediaType: "image/png" }],
      },
    ];
    const estimate = await estimateChatRequestTokens({
      systemPrompt: "system",
      tools: {},
      transcript,
      outputReserveTokens: 16_000,
    });
    assert.equal(estimate.hydratedImageTokens, CHAT_HYDRATED_IMAGE_TOKENS);
    assert.ok(estimate.transcriptTokens < 100);
  });

  test("requires synchronous compaction only above 85% of input capacity", async () => {
    const atBoundary = await assessChatRequestPressure({
      systemPrompt: "",
      tools: {},
      transcript: [],
      contextWindowTokens: 20_000,
      outputReserveTokens: 16_000,
    });
    assert.equal(atBoundary.synchronousCompactionThresholdTokens, 3_400);
    assert.equal(atBoundary.requiresSynchronousCompaction, false);

    const pressured = await assessChatRequestPressure({
      systemPrompt: "x".repeat(14_000),
      tools: {},
      transcript: [],
      contextWindowTokens: 20_000,
      outputReserveTokens: 16_000,
    });
    assert.equal(pressured.requiresSynchronousCompaction, true);
  });
});
