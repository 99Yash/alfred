import {
  embed,
  generateObject,
  generateText,
  type EmbedResult,
  type GenerateObjectResult,
  type GenerateTextResult,
  type LanguageModel,
  type LanguageModelUsage,
  type ToolSet,
} from "ai";
import { metered } from "./metered";
import type { CallAttribution, MeteredMeta, MeteredResult } from "./types";

/**
 * AI-SDK call wrappers — thin sugar over `metered()`. They:
 *   1. Call the underlying SDK function with the caller's args.
 *   2. Extract `usage` and a small `responseMeta` shape from the result.
 *   3. Forward provider+model identifiers to the metering layer.
 *
 * Provider/model identifiers are inferred from the `LanguageModel` (which
 * carries `.provider` + `.modelId` since AI SDK v5+). When the SDK no
 * longer exposes them, callers can override via `meta`.
 */

interface ModelIdentifiers {
  provider: string;
  model: string;
}

function modelIdsFor(model: LanguageModel): ModelIdentifiers {
  // AI SDK v6: LanguageModel is a union; narrow it to the object shape that
  // exposes provider + modelId. Fallback to "unknown" so missing fields
  // don't blow up the call — the log row still lands.
  if (typeof model === "object" && model && "provider" in model && "modelId" in model) {
    return {
      provider: normalizeProvider(String(model.provider)),
      model: String(model.modelId),
    };
  }
  return { provider: "unknown", model: String(model) };
}

/**
 * AI SDK exposes namespaced provider ids (`google.generative-ai`,
 * `anthropic.messages`, `openai.responses`). models.dev uses the short
 * names (`google`, `anthropic`, `openai`). Normalize so price lookups hit.
 */
function normalizeProvider(raw: string): string {
  // Take everything up to the first `.` — keeps unknown providers intact.
  const head = raw.split(".")[0] ?? raw;
  return head;
}

function extractTextUsage<TOOLS extends ToolSet, OUTPUT>(
  result: GenerateTextResult<TOOLS, OUTPUT>,
): MeteredResult {
  return {
    usage: usageFromSdk(result.totalUsage),
    responseMeta: {
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      stepCount: result.steps?.length,
    },
  };
}

function extractObjectUsage<O>(result: GenerateObjectResult<O>): MeteredResult {
  return {
    usage: usageFromSdk(result.usage),
    responseMeta: {
      finishReason: result.finishReason,
    },
  };
}

function extractEmbedUsage(result: EmbedResult): MeteredResult {
  return {
    usage: { inputTokens: result.usage.tokens, outputTokens: 0 },
    responseMeta: { dim: result.embedding.length },
  };
}

function usageFromSdk(usage: LanguageModelUsage | undefined) {
  if (!usage) return undefined;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: cacheReadTokens,
  };
}

export type GenerateTextArgs = Parameters<typeof generateText>[0];
export type GenerateObjectArgs = Parameters<typeof generateObject>[0];
export type EmbedArgs = Parameters<typeof embed>[0];

export interface AttributedCall extends CallAttribution {
  /** Trimmed params surfaced to `request_meta` (avoid full prompts). */
  requestMeta?: Record<string, unknown>;
  /** Override provider/model identifiers — only useful for routed/dispatched models. */
  provider?: string;
  model?: string;
  /** Free-form Langfuse span name. Defaults to `${provider}/${model}`. */
  name?: string;
  /** Stable per-call idempotency key. Forwarded to log row + Langfuse trace metadata. */
  idempotencyKey?: string;
}

export async function meteredGenerateText<TOOLS extends ToolSet>(
  args: GenerateTextArgs,
  attribution: AttributedCall = {},
) {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "llm", ...ids };
  return metered(meta, () => generateText(args), extractTextUsage as never) as Promise<
    GenerateTextResult<TOOLS, never>
  >;
}

export async function meteredGenerateObject<O>(
  args: GenerateObjectArgs,
  attribution: AttributedCall = {},
) {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "llm", ...ids };
  return metered(meta, () => generateObject(args), extractObjectUsage as never) as Promise<
    GenerateObjectResult<O>
  >;
}

export async function meteredEmbed(
  args: EmbedArgs,
  attribution: AttributedCall = {},
): Promise<EmbedResult> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "embedding", ...ids };
  return metered(meta, () => embed(args), extractEmbedUsage);
}

function resolveIds(model: unknown, attribution: AttributedCall): ModelIdentifiers {
  if (attribution.provider && attribution.model) {
    return { provider: attribution.provider, model: attribution.model };
  }
  return modelIdsFor(model as LanguageModel);
}
