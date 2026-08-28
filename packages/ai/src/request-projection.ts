import type { LanguageModelV4CallOptions, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { getPath, toRecord } from "@alfred/contracts";
import { z } from "zod";

export type CacheTtl = "5m" | "1h";

/**
 * Deep module owning the per-turn envelope and Anthropic cache projection.
 * Agent → provider adapter seam: AlfredAgent attaches `alfredInternal:{cacheTtl}`
 * which is consumed here before provider dispatch — never wire metadata.
 */
const INTERNAL_PROVIDER_NAMESPACE = "alfredInternal";

const turnEnvelopeSchema = z
  .object({
    cacheTtl: z.union([z.literal("5m"), z.literal("1h"), z.null()]),
  })
  .strict();

type PromptMessage = LanguageModelV4CallOptions["prompt"][number];
type ToolDefinition = NonNullable<LanguageModelV4CallOptions["tools"]>[number];
type FunctionToolDefinition = Extract<ToolDefinition, { type: "function" }>;

export function attachProviderTurnPolicy(
  providerOptions: Record<string, Record<string, unknown>> | SharedV4ProviderOptions | undefined,
  cacheTtl: CacheTtl | undefined,
): SharedV4ProviderOptions {
  // SAFETY: this is the single conversion from Alfred's loose providerOptions surface to the SDK's JSONObject shape; values are typed provider bags plus JSON envelope.
  return {
    // SAFETY: providerOptions is already SharedV4ProviderOptions-compatible when it comes from typed builders.
    ...(providerOptions as SharedV4ProviderOptions | undefined),
    [INTERNAL_PROVIDER_NAMESPACE]: { cacheTtl: cacheTtl ?? null },
  } as SharedV4ProviderOptions;
}

interface TurnEnvelopeConsume {
  cacheTtl: CacheTtl | undefined;
  providerOptions: SharedV4ProviderOptions | undefined;
}

function consumeTurnEnvelope(
  providerOptions: LanguageModelV4CallOptions["providerOptions"],
): TurnEnvelopeConsume {
  // SAFETY: providerOptions is SharedV4ProviderOptions (record of JSONObject); toRecord validates the boundary.
  const existing = toRecord(providerOptions);
  const { [INTERNAL_PROVIDER_NAMESPACE]: envelope, ...rest } = existing;
  const parsed = turnEnvelopeSchema.safeParse(envelope);
  return {
    cacheTtl: parsed.success ? (parsed.data.cacheTtl ?? undefined) : undefined,
    // SAFETY: rest is the caller's providerOptions minus our internal namespace; same Record<string, JSONObject> shape.
    providerOptions: Object.keys(rest).length > 0 ? (rest as SharedV4ProviderOptions) : undefined,
  };
}

function withAnthropicCacheControl<
  T extends { readonly providerOptions?: LanguageModelV4CallOptions["providerOptions"] },
>(value: T, ttl: CacheTtl): T {
  const existing = value.providerOptions ?? {};
  // SAFETY: existing is SharedV4ProviderOptions; getPath reads the nested anthropic bag off the validated record.
  const anthropic = toRecord(getPath(existing as unknown, "anthropic"));
  return {
    ...value,
    providerOptions: {
      ...existing,
      anthropic: {
        ...anthropic,
        cacheControl: { type: "ephemeral", ttl },
      },
    },
  };
}

function previousToolBurstBoundaryIndex(transcript: readonly PromptMessage[]): number | null {
  let firstTrailingToolIndex = transcript.length;
  while (firstTrailingToolIndex > 0 && transcript[firstTrailingToolIndex - 1]?.role === "tool") {
    firstTrailingToolIndex--;
  }
  if (firstTrailingToolIndex === transcript.length) return null;
  const assistantIndex = firstTrailingToolIndex - 1;
  if (assistantIndex < 1 || transcript[assistantIndex]?.role !== "assistant") return null;
  return assistantIndex - 1;
}

function decorateAnthropicPrompt(
  prompt: LanguageModelV4CallOptions["prompt"],
  ttl: CacheTtl,
): LanguageModelV4CallOptions["prompt"] {
  if (prompt.length === 0) return prompt;
  const out = prompt.slice();
  if (out[0]?.role === "system") {
    out[0] = withAnthropicCacheControl(out[0], ttl);
  }
  const transcriptStart = out[0]?.role === "system" ? 1 : 0;
  if (transcriptStart === out.length) return out;
  const transcript = out.slice(transcriptStart);
  const boundary = previousToolBurstBoundaryIndex(transcript);
  if (boundary !== null) {
    transcript[boundary] = withAnthropicCacheControl(transcript[boundary]!, ttl);
  }
  const last = transcript.length - 1;
  transcript[last] = withAnthropicCacheControl(transcript[last]!, ttl);
  out.splice(transcriptStart, transcript.length, ...transcript);
  return out;
}

function decorateAnthropicTools(
  tools: NonNullable<LanguageModelV4CallOptions["tools"]>,
  ttl: CacheTtl,
): NonNullable<LanguageModelV4CallOptions["tools"]> {
  if (tools.length === 0) return tools;
  const out = tools.slice();
  let lastFunctionIndex = -1;
  for (let index = 0; index < out.length; index++) {
    if (out[index]?.type === "function") lastFunctionIndex = index;
  }
  if (lastFunctionIndex === -1) return out;
  out[lastFunctionIndex] = withAnthropicCacheControl(
    // SAFETY: lastFunctionIndex was set only where entry.type === "function", matching FunctionToolDefinition discriminant.
    out[lastFunctionIndex] as FunctionToolDefinition,
    ttl,
  );
  return out;
}

interface CleanProviderRequest {
  clean: LanguageModelV4CallOptions;
  cacheTtl: CacheTtl | undefined;
}

function cleanProviderRequest(params: LanguageModelV4CallOptions): CleanProviderRequest {
  const { cacheTtl, providerOptions } = consumeTurnEnvelope(params.providerOptions);
  const { providerOptions: _internalOptions, ...rest } = params;
  const clean = {
    ...rest,
    ...(providerOptions ? { providerOptions } : {}),
    // SAFETY: rest preserves all LanguageModelV4CallOptions fields minus providerOptions which we replace.
  } as LanguageModelV4CallOptions;
  return { clean, cacheTtl };
}

function projectApplicationRequest(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  return params;
}

function projectAnthropicRequest(
  params: LanguageModelV4CallOptions,
  cacheTtl: CacheTtl | undefined,
): LanguageModelV4CallOptions {
  if (!cacheTtl) return params;
  return {
    ...params,
    prompt: decorateAnthropicPrompt(params.prompt, cacheTtl),
    ...(params.tools ? { tools: decorateAnthropicTools(params.tools, cacheTtl) } : {}),
  };
}

export function projectRequestForModel(
  modelId: string,
  params: LanguageModelV4CallOptions,
  cacheTtl: CacheTtl | undefined,
  isAnthropic: boolean,
): LanguageModelV4CallOptions {
  void modelId;
  return isAnthropic
    ? projectAnthropicRequest(params, cacheTtl)
    : projectApplicationRequest(params);
}

export interface CleanAndProjectResult {
  clean: LanguageModelV4CallOptions;
  cacheTtl: CacheTtl | undefined;
  projected: LanguageModelV4CallOptions;
}

export function cleanAndProjectRequest(
  params: LanguageModelV4CallOptions,
  isAnthropic: boolean,
): CleanAndProjectResult {
  const { clean, cacheTtl } = cleanProviderRequest(params);
  const projected = projectRequestForModel("", clean, cacheTtl, isAnthropic);
  return { clean, cacheTtl, projected };
}

// Re-export helpers for the adapter composer without leaking internals broadly.
export { cleanProviderRequest, projectAnthropicRequest, projectApplicationRequest };
