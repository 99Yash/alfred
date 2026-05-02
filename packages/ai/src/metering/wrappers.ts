import {
  embed,
  generateText,
  Output,
  type CallWarning,
  type EmbedResult,
  type FinishReason,
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

// `metered()` only reads `totalUsage`/`finishReason`/`toolCalls`/`steps`,
// none of which depend on the OUTPUT generic — so we collapse to the
// widest valid instantiation and let the call site cast through `never`.
function extractTextUsage(result: GenerateTextResult<ToolSet, never>): MeteredResult {
  return {
    usage: usageFromSdk(result.totalUsage),
    responseMeta: {
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      stepCount: result.steps?.length,
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
export type EmbedArgs = Parameters<typeof embed>[0];

type ObjectSchema<O> = Parameters<typeof Output.object<O>>[0]["schema"];

export interface MeteredGenerateObjectArgs<O>
  extends Omit<GenerateTextArgs, "output" | "experimental_output"> {
  schema: ObjectSchema<O>;
  /** Optional name forwarded to `Output.object` — some providers use it for tool/schema naming. */
  schemaName?: string;
  /** Optional description forwarded to `Output.object` — surfaces as additional LLM guidance. */
  schemaDescription?: string;
}

export interface MeteredGenerateObjectResult<O> {
  object: O;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  warnings: CallWarning[] | undefined;
}

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

export async function meteredGenerateText(
  args: GenerateTextArgs,
  attribution: AttributedCall = {},
): Promise<GenerateTextResult<ToolSet, never>> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "llm", ...ids };
  // The SDK's natural return type is GenerateTextResult<ToolSet, Output<any,…>>
  // but the `Output` interface is not exported as a nameable type, only via a
  // namespace alias. Cast through unknown to a callable shape and pin the
  // public return type to <ToolSet, never>, which downstream callers (which
  // never use `experimental_output`) can read freely.
  return metered(meta, () => generateText(args), extractTextUsage as never) as unknown as Promise<
    GenerateTextResult<ToolSet, never>
  >;
}

/**
 * Structured-output wrapper. AI SDK v6 deprecated `generateObject` in favor of
 * `generateText` + `Output.object`, so we route through the text path and
 * project the schema-validated result into a `{ object, usage, ... }` shape
 * to keep call sites stable.
 */
export async function meteredGenerateObject<O>(
  args: MeteredGenerateObjectArgs<O>,
  attribution: AttributedCall = {},
): Promise<MeteredGenerateObjectResult<O>> {
  const { schema, schemaName, schemaDescription, ...rest } = args;
  const ids = resolveIds(rest.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "llm", ...ids };
  type Result = GenerateTextResult<ToolSet, ReturnType<typeof Output.object<O>>>;
  // The discriminated `Prompt` union (prompt | messages) doesn't survive an
  // Omit/spread round trip — TS widens `messages` to `T[] | undefined`. Cast
  // back to the SDK's parameter type so the call type-checks; the original
  // `args` already satisfied the union.
  const callArgs = {
    ...rest,
    output: Output.object({
      schema,
      name: schemaName,
      description: schemaDescription,
    }),
  } as unknown as Parameters<typeof generateText>[0];
  const result = (await metered(
    meta,
    () => generateText(callArgs),
    extractTextUsage as never,
  )) as unknown as Result;
  return {
    object: result.output,
    usage: result.totalUsage,
    finishReason: result.finishReason,
    warnings: result.warnings,
  };
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
