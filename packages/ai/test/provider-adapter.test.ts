import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getPath } from "@alfred/contracts";
import { anthropic } from "@ai-sdk/anthropic";
import { APICallError, generateText, tool, type ToolSet } from "ai";
import type { LanguageModel } from "ai-retry";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { MODEL_DEFINITIONS, type ModelId, type ModelProviderId } from "../src/models";
import {
  attachProviderTurnPolicy,
  createProviderModel,
  withProviderAdapter,
} from "../src/provider-adapter";
import { withFallback } from "../src/provider";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function okResult(): GenResult {
  return {
    content: [{ type: "text" as const, text: "ok" }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  };
}

function mockModel(provider: ModelProviderId, modelId: ModelId): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider,
    modelId,
    doGenerate: async () => okResult(),
  });
}

// eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
const asModel = (model: MockLanguageModelV4) => model as unknown as LanguageModel;

// Reads a nested field off an SDK object, so it takes `unknown` and uses the
// shared `getPath` reader rather than a hand-written structural type.
function cacheControl(value: unknown): unknown {
  return getPath(value, "providerOptions", "anthropic", "cacheControl");
}

const tools: ToolSet = {
  "system.search_tools": tool({
    description: "Search the catalog",
    inputSchema: z.object({ query: z.string() }),
  }),
};

describe("provider turn protocol", () => {
  test("constructs every registered model through the provider adapter seam", () => {
    for (const definition of MODEL_DEFINITIONS) {
      const model = createProviderModel(definition.id);
      assert.equal(model.modelId, definition.id);
      assert.match(model.provider, new RegExp(`^${definition.provider}(?:\\.|$)`));
    }
  });

  test("Anthropic consumes the internal envelope and owns all cache decoration", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));

    await generateText({
      model,
      instructions: "stable system",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
      tools,
      providerOptions: attachProviderTurnPolicy({ anthropic: { effort: "medium" } }, "1h"),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    assert.deepEqual(call.providerOptions, { anthropic: { effort: "medium" } });
    assert.equal("alfredInternal" in (call.providerOptions ?? {}), false);
    assert.equal(call.tools?.[0]?.name, "system__search_tools");
    assert.deepEqual(cacheControl(call.tools![0]!), { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(cacheControl(call.prompt[0]!), { type: "ephemeral", ttl: "1h" });
    assert.equal(cacheControl(call.prompt[1]!), undefined);
    assert.equal(cacheControl(call.prompt[2]!), undefined);
    assert.deepEqual(cacheControl(call.prompt[3]!), { type: "ephemeral", ttl: "1h" });
  });

  test("Google consumes the same envelope without receiving Anthropic metadata", async () => {
    const inner = mockModel("google", "gemini-3.5-flash");
    const model = withProviderAdapter("gemini-3.5-flash", asModel(inner));

    await generateText({
      model,
      instructions: "stable system",
      messages: [{ role: "user", content: "hello" }],
      tools,
      providerOptions: attachProviderTurnPolicy(
        { google: { thinkingConfig: { thinkingLevel: "medium" } } },
        "1h",
      ),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    assert.deepEqual(call.providerOptions, {
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
    assert.equal(call.tools?.[0]?.name, "system__search_tools");
    assert.equal(cacheControl(call.tools![0]!), undefined);
    assert.equal(cacheControl(call.prompt[0]!), undefined);
    assert.equal(cacheControl(call.prompt[1]!), undefined);
  });

  test("OpenAI consumes the envelope and uses the adapter-owned name policy", async () => {
    const inner = mockModel("openai", "gpt-5.6-sol");
    const model = withProviderAdapter("gpt-5.6-sol", asModel(inner));

    await generateText({
      model,
      prompt: "hello",
      tools,
      providerOptions: attachProviderTurnPolicy({ openai: { reasoningEffort: "medium" } }, "1h"),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    assert.deepEqual(call.providerOptions, { openai: { reasoningEffort: "medium" } });
    assert.equal("alfredInternal" in (call.providerOptions ?? {}), false);
    assert.equal(call.tools?.[0]?.name, "system__search_tools");
    assert.equal(cacheControl(call.tools![0]!), undefined);
    assert.equal(cacheControl(call.prompt[0]!), undefined);
  });

  test("name encoding leaves provider-defined tools unchanged", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));

    await generateText({
      model,
      prompt: "hello",
      // The SDK unifies the two entries' input generic to `never` inside the
      // non-generic `ToolSet`, so a provider-defined tool needs the same
      // `as ToolSet` cast `googleSearchGroundingTools` uses in `src/provider.ts`.
      tools: {
        ...tools,
        anthropic_tool_search: anthropic.tools.toolSearchBm25_20251119(),
      } as ToolSet,
      providerOptions: attachProviderTurnPolicy(undefined, undefined),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    const providerTool = call.tools?.find((definition) => definition.type === "provider");
    assert.ok(providerTool);
    assert.equal(providerTool.id, "anthropic.tool_search_bm25_20251119");
    assert.equal(
      call.tools?.find((definition) => definition.type === "function")?.name,
      "system__search_tools",
    );
  });

  test("a cross-provider fallback reprojects the same request for Google", async () => {
    const primary = new MockLanguageModelV4({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      doGenerate: async () => {
        throw new APICallError({
          message: "workspace API usage limit reached",
          url: "https://mock.invalid/v1",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    });
    const fallback = mockModel("google", "gemini-3.5-flash");
    const model = withFallback(
      withProviderAdapter("claude-sonnet-4-6", asModel(primary)),
      withProviderAdapter("gemini-3.5-flash", asModel(fallback)),
    );

    await generateText({
      model,
      instructions: "stable system",
      messages: [{ role: "user", content: "hello" }],
      tools,
      providerOptions: attachProviderTurnPolicy(undefined, "1h"),
      maxRetries: 0,
    });

    const primaryCall = primary.doGenerateCalls[0];
    const fallbackCall = fallback.doGenerateCalls[0];
    assert.ok(primaryCall);
    assert.ok(fallbackCall);
    assert.deepEqual(cacheControl(primaryCall.prompt[0]!), {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.equal(cacheControl(fallbackCall.prompt[0]!), undefined);
    assert.equal(cacheControl(fallbackCall.tools![0]!), undefined);
    assert.equal("alfredInternal" in (fallbackCall.providerOptions ?? {}), false);
  });

  test("malformed internal metadata fails closed and is still stripped", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));

    await generateText({
      model,
      prompt: "hello",
      tools,
      providerOptions: { alfredInternal: { cacheTtl: "forever" } },
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    assert.equal(call.providerOptions, undefined);
    assert.equal(cacheControl(call.tools![0]!), undefined);
    assert.equal(cacheControl(call.prompt[0]!), undefined);
  });

  test("disabled caching strips the envelope without adding breakpoints", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));

    await generateText({
      model,
      instructions: "stable system",
      messages: [{ role: "user", content: "hello" }],
      tools,
      providerOptions: attachProviderTurnPolicy(undefined, undefined),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    assert.equal(call.providerOptions, undefined);
    assert.equal(cacheControl(call.tools![0]!), undefined);
    assert.equal(cacheControl(call.prompt[0]!), undefined);
    assert.equal(cacheControl(call.prompt[1]!), undefined);
  });

  test("cache projection preserves existing provider options", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));

    await generateText({
      model,
      instructions: "stable system",
      messages: [
        {
          role: "user",
          content: "hello",
          providerOptions: {
            anthropic: { custom: "keep" },
            openai: { other: "keep" },
          },
        },
      ],
      tools,
      providerOptions: attachProviderTurnPolicy(undefined, "1h"),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    const last = call.prompt.at(-1);
    assert.ok(last);
    assert.equal(last.providerOptions?.anthropic?.custom, "keep");
    assert.equal(last.providerOptions?.openai?.other, "keep");
    assert.deepEqual(cacheControl(last), { type: "ephemeral", ttl: "1h" });
  });

  test("tool-result bursts retain a prior cache-read boundary within the four-breakpoint cap", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));
    const toolResults = Array.from({ length: 32 }, (_, index) => ({
      type: "tool-result" as const,
      toolCallId: `call_${index}`,
      toolName: "system.search_tools",
      output: { type: "text" as const, value: `r${index}` },
    }));

    await generateText({
      model,
      instructions: "stable system",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_0",
              toolName: "system.search_tools",
              input: { query: "x" },
            },
          ],
        },
        { role: "tool", content: toolResults },
      ],
      tools,
      providerOptions: attachProviderTurnPolicy(undefined, "5m"),
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    const cached = call.prompt.flatMap((message, index) =>
      cacheControl(message) === undefined ? [] : [index],
    );
    assert.deepEqual(cached, [0, 3, call.prompt.length - 1]);
    assert.ok(cached.length + 1 <= 4, "system + tool + transcript cache points stay within cap");
  });

  test("compacted tool bursts stay within the four-breakpoint cap", async () => {
    const inner = mockModel("anthropic", "claude-sonnet-4-6");
    const model = withProviderAdapter("claude-sonnet-4-6", asModel(inner));
    const toolResults = Array.from({ length: 8 }, (_, index) => ({
      type: "tool-result" as const,
      toolCallId: `call_${index}`,
      toolName: "system.search_tools",
      output: { type: "text" as const, value: `r${index}` },
    }));

    await generateText({
      model,
      instructions: "stable system",
      messages: [
        { role: "system", content: "<run_summary>summary</run_summary>" },
        { role: "user", content: "again" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_0",
              toolName: "system.search_tools",
              input: { query: "x" },
            },
          ],
        },
        { role: "tool", content: toolResults },
      ],
      tools,
      providerOptions: attachProviderTurnPolicy(undefined, "1h"),
      allowSystemInMessages: true,
    });

    const call = inner.doGenerateCalls[0];
    assert.ok(call);
    const cached = call.prompt.filter((message) => cacheControl(message) !== undefined);
    assert.ok(cached.length + 1 <= 4, "system + tool + transcript cache points stay within cap");
  });

  test("refuses to bind a protocol to the wrong concrete model", () => {
    assert.throws(
      () =>
        withProviderAdapter("claude-sonnet-4-6", asModel(mockModel("google", "gemini-3.5-flash"))),
      /expected anthropic\/claude-sonnet-4-6/,
    );
  });
});
