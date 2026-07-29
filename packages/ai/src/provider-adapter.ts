import { anthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { google, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import { openai, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import { INTEGRATION_ACTIONS, type IntegrationSlug, toRecord } from "@alfred/contracts";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { z } from "zod";
import {
  type EffortLevel,
  EFFORT_LEVELS,
  MODEL_CAPABILITIES,
  MODEL_IDS,
  MODEL_REGISTRY,
  type ModelId,
  type ModelIdFor,
  type ModelProviderId,
  normalizeProvider,
} from "./models";

type CacheTtl = "5m" | "1h";
type ToolLoadingProtocol = "application" | "native";
type ToolNameEncoding = "double-underscore" | "identity";

type AnthropicChatProviderOptions = Pick<AnthropicLanguageModelOptions, "thinking" | "effort">;
type GoogleChatProviderOptions = Pick<GoogleLanguageModelOptions, "thinkingConfig">;
type OpenAIChatProviderOptions = Pick<OpenAILanguageModelResponsesOptions, "reasoningEffort">;
type AnthropicEffortLevel = NonNullable<AnthropicChatProviderOptions["effort"]>;
type GoogleThinkingLevel = NonNullable<
  NonNullable<GoogleChatProviderOptions["thinkingConfig"]>["thinkingLevel"]
>;
type CallOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type ProviderOptions = NonNullable<CallOptions["providerOptions"]>;
type ProviderOptionBag = NonNullable<ProviderOptions[string]>;

interface ProviderAdapter<M extends ModelId> {
  readonly toolNameMaxLen: number;
  readonly toolNameEncoding: ToolNameEncoding;
  readonly nativeToolSearch: boolean;
  createModel(modelId: M): LanguageModelV4;
  reasoningOptions(modelId: M, effort: EffortLevel): ProviderOptionBag;
  disabledReasoningOptions(modelId: M): ProviderOptionBag;
  projectRequest(params: CallOptions, cacheTtl: CacheTtl | undefined): CallOptions;
}

type ProviderAdapterMap = {
  readonly [P in ModelProviderId]: ProviderAdapter<ModelIdFor<P>>;
};

function clampEffort(desired: EffortLevel, allowed: readonly EffortLevel[]): EffortLevel {
  const target = EFFORT_LEVELS.indexOf(desired);
  return allowed.reduce((best, current) =>
    Math.abs(EFFORT_LEVELS.indexOf(current) - target) <
    Math.abs(EFFORT_LEVELS.indexOf(best) - target)
      ? current
      : best,
  );
}

function isAnthropicEffortLevel(value: EffortLevel): value is AnthropicEffortLevel {
  return value !== "none" && value !== "minimal";
}

function isGoogleThinkingLevel(value: EffortLevel): value is GoogleThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}

/**
 * One deep provider adapter map. Each entry owns every SDK-adapter fact:
 * concrete construction, reasoning shape, name policy, cache/protocol selection,
 * and eventually native deferred-tool projection.
 */
const PROVIDER_ADAPTERS = {
  anthropic: {
    toolNameMaxLen: 128,
    toolNameEncoding: "double-underscore",
    nativeToolSearch: false,
    createModel: (modelId: ModelIdFor<"anthropic">) => anthropic(modelId),
    reasoningOptions(
      modelId: ModelIdFor<"anthropic">,
      effort: EffortLevel,
    ): AnthropicChatProviderOptions {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      if (effortValues.length === 0) return {};
      const clampedEffort = clampEffort(effort, effortValues);
      if (!isAnthropicEffortLevel(clampedEffort)) {
        throw new Error(
          `${modelId} declares Anthropic-incompatible effort value "${clampedEffort}"`,
        );
      }
      return {
        thinking: { type: "adaptive", display: "summarized" },
        effort: clampedEffort,
      };
    },
    disabledReasoningOptions: (_modelId: ModelIdFor<"anthropic">) => ({
      thinking: { type: "disabled" },
    }),
    projectRequest: projectAnthropicRequest,
  },
  google: {
    toolNameMaxLen: 64,
    toolNameEncoding: "double-underscore",
    nativeToolSearch: false,
    createModel: (modelId: ModelIdFor<"google">) => google(modelId),
    reasoningOptions(
      modelId: ModelIdFor<"google">,
      effort: EffortLevel,
    ): GoogleChatProviderOptions {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      if (effortValues.length > 0) {
        const thinkingLevel = clampEffort(effort, effortValues);
        if (!isGoogleThinkingLevel(thinkingLevel)) {
          throw new Error(`${modelId} declares Google-incompatible effort "${thinkingLevel}"`);
        }
        return { thinkingConfig: { includeThoughts: true, thinkingLevel } };
      }
      return { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
    },
    disabledReasoningOptions: (_modelId: ModelIdFor<"google">) => ({
      thinkingConfig: { thinkingBudget: 0 },
    }),
    projectRequest: projectApplicationRequest,
  },
  openai: {
    toolNameMaxLen: 64,
    toolNameEncoding: "double-underscore",
    nativeToolSearch: false,
    createModel: (modelId: ModelIdFor<"openai">) => openai.responses(modelId),
    reasoningOptions(
      modelId: ModelIdFor<"openai">,
      effort: EffortLevel,
    ): OpenAIChatProviderOptions {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      return { reasoningEffort: clampEffort(effort, effortValues) };
    },
    disabledReasoningOptions: (_modelId: ModelIdFor<"openai">) => ({
      reasoningEffort: "none",
    }),
    projectRequest: projectApplicationRequest,
  },
} as const satisfies ProviderAdapterMap;

/**
 * Code-resident rollout gate. It starts empty: capability discovery and module
 * extraction must not silently change a product route's wire representation.
 */
const NATIVE_TOOL_LOADING_MODELS: ReadonlySet<ModelId> = new Set();

function adapterForModel(modelId: ModelId): ProviderAdapter<ModelId> {
  const provider = MODEL_REGISTRY[modelId];
  // SAFETY: ProviderAdapterMap keys each entry by the exact ModelIdFor<P>
  // derived from MODEL_REGISTRY. Looking the entry up through that same registry
  // preserves the relation, but TypeScript cannot retain it through indexed access.
  return PROVIDER_ADAPTERS[provider] as ProviderAdapter<ModelId>;
}

/**
 * Resolve the protocol selected for a concrete model. Capability, provider
 * mechanics, and rollout enablement must all agree before native mode can run.
 */
function toolLoadingProtocolForModel(modelId: ModelId): ToolLoadingProtocol {
  return MODEL_CAPABILITIES[modelId].nativeToolSearch &&
    adapterForModel(modelId).nativeToolSearch &&
    NATIVE_TOOL_LOADING_MODELS.has(modelId)
    ? "native"
    : "application";
}

function assertProtocolRegistry(): void {
  for (const modelId of NATIVE_TOOL_LOADING_MODELS) {
    if (toolLoadingProtocolForModel(modelId) !== "native") {
      throw new Error(
        `${modelId} enables native tool loading without capability and adapter support`,
      );
    }
  }
  for (const [provider, adapter] of Object.entries(PROVIDER_ADAPTERS) as [
    ModelProviderId,
    ProviderAdapter<ModelId>,
  ][]) {
    const reachable = MODEL_IDS.some(
      (modelId) =>
        MODEL_REGISTRY[modelId] === provider && MODEL_CAPABILITIES[modelId].nativeToolSearch,
    );
    if (adapter.nativeToolSearch && !reachable) {
      throw new Error(`${provider} native tool-search adapter is unreachable`);
    }
  }
}

assertProtocolRegistry();

function encodeToolName(name: string, encoding: ToolNameEncoding): string {
  return encoding === "double-underscore" ? name.replace(".", "__") : name;
}

function decodeToolName(name: string, encoding: ToolNameEncoding): string {
  return encoding === "double-underscore" ? name.replace("__", ".") : name;
}

function assertToolNameRegistry(): void {
  for (const adapter of Object.values(PROVIDER_ADAPTERS)) {
    for (const [integration, actions] of Object.entries(INTEGRATION_ACTIONS) as [
      IntegrationSlug,
      readonly string[],
    ][]) {
      for (const action of actions) {
        const name = `${integration}.${action}`;
        const encoded = encodeToolName(name, adapter.toolNameEncoding);
        if (
          adapter.toolNameEncoding === "double-underscore" &&
          (name.split(".").length !== 2 || name.includes("__"))
        ) {
          throw new Error(`${name} cannot round-trip through the provider tool-name encoding`);
        }
        if (!/^[a-zA-Z0-9_.-]+$/.test(encoded) || encoded.length > adapter.toolNameMaxLen) {
          throw new Error(`${name} exceeds a provider tool-name policy`);
        }
      }
    }
  }
}

assertToolNameRegistry();

const INTERNAL_PROVIDER_NAMESPACE = "alfredInternal";
const turnEnvelopeSchema = z
  .object({
    cacheTtl: z.union([z.literal("5m"), z.literal("1h"), z.null()]),
  })
  .strict();

type InputProviderOptions = Record<string, Record<string, unknown>>;
type PromptMessage = CallOptions["prompt"][number];
type ToolDefinition = NonNullable<CallOptions["tools"]>[number];
type FunctionToolDefinition = Extract<ToolDefinition, { type: "function" }>;

/**
 * Attach trusted turn policy for the concrete protocol wrapper. The wrapper
 * consumes this namespace before provider dispatch; it is never wire metadata.
 */
export function attachProviderTurnPolicy(
  providerOptions: InputProviderOptions | undefined,
  cacheTtl: CacheTtl | undefined,
): ProviderOptions {
  // SAFETY: this is the single conversion from Alfred's intentionally loose
  // provider-options interface to the SDK's JSON provider-options type. The
  // values are authored by typed provider builders plus the JSON-only envelope.
  return {
    ...providerOptions,
    [INTERNAL_PROVIDER_NAMESPACE]: { cacheTtl: cacheTtl ?? null },
  } as ProviderOptions;
}

function consumeTurnEnvelope(providerOptions: CallOptions["providerOptions"]): {
  cacheTtl: CacheTtl | undefined;
  providerOptions: CallOptions["providerOptions"];
} {
  const existing = toRecord(providerOptions);
  const { [INTERNAL_PROVIDER_NAMESPACE]: envelope, ...rest } = existing;
  const parsed = turnEnvelopeSchema.safeParse(envelope);
  return {
    cacheTtl: parsed.success ? (parsed.data.cacheTtl ?? undefined) : undefined,
    providerOptions: Object.keys(rest).length > 0 ? (rest as ProviderOptions) : undefined,
  };
}

function withAnthropicCacheControl<
  T extends { readonly providerOptions?: CallOptions["providerOptions"] },
>(value: T, ttl: CacheTtl): T {
  const existing = value.providerOptions ?? {};
  const anthropic = toRecord(existing.anthropic);
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
  prompt: CallOptions["prompt"],
  ttl: CacheTtl,
): CallOptions["prompt"] {
  if (prompt.length === 0) return prompt;
  const out = prompt.slice();

  // AlfredAgent supplies exactly one instructions block. Any later system
  // message is transcript state (for example <run_summary>) and participates
  // only in the transcript breakpoint policy below.
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
  tools: NonNullable<CallOptions["tools"]>,
  ttl: CacheTtl,
): NonNullable<CallOptions["tools"]> {
  if (tools.length === 0) return tools;
  const out = tools.slice();
  let lastFunctionIndex = -1;
  for (let index = 0; index < out.length; index++) {
    if (out[index]?.type === "function") lastFunctionIndex = index;
  }
  if (lastFunctionIndex === -1) return out;
  out[lastFunctionIndex] = withAnthropicCacheControl(
    out[lastFunctionIndex] as FunctionToolDefinition,
    ttl,
  );
  return out;
}

function cleanProviderRequest(params: CallOptions): {
  clean: CallOptions;
  cacheTtl: CacheTtl | undefined;
} {
  const { cacheTtl, providerOptions } = consumeTurnEnvelope(params.providerOptions);
  const { providerOptions: _internalOptions, ...rest } = params;
  const clean = {
    ...rest,
    ...(providerOptions ? { providerOptions } : {}),
  };
  return { clean, cacheTtl };
}

function projectApplicationRequest(params: CallOptions): CallOptions {
  return params;
}

function projectAnthropicRequest(params: CallOptions, cacheTtl: CacheTtl | undefined): CallOptions {
  if (!cacheTtl) return params;
  return {
    ...params,
    prompt: decorateAnthropicPrompt(params.prompt, cacheTtl),
    ...(params.tools ? { tools: decorateAnthropicTools(params.tools, cacheTtl) } : {}),
  };
}

function middlewareFor(modelId: ModelId): LanguageModelMiddleware {
  const adapter = adapterForModel(modelId);
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const { clean, cacheTtl } = cleanProviderRequest(params);
      return adapter.projectRequest(clean, cacheTtl);
    },
  };
}

/**
 * Provider-boundary name transform. Alfred keeps dotted canonical names while
 * provider adapters receive their stricter reversible representation.
 */
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>>;
type ContentPart = GenerateResult["content"][number];
type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type MessagePart = Extract<PromptMessage["content"], readonly unknown[]>[number];

function encodeMessagePart(part: MessagePart, encoding: ToolNameEncoding): MessagePart {
  if ((part.type === "tool-call" || part.type === "tool-result") && "toolName" in part) {
    return { ...part, toolName: encodeToolName(part.toolName, encoding) };
  }
  return part;
}

function encodePromptMessage(message: PromptMessage, encoding: ToolNameEncoding): PromptMessage {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) => encodeMessagePart(part, encoding)),
  } as PromptMessage;
}

function encodeParams(params: CallOptions, encoding: ToolNameEncoding): CallOptions {
  return {
    ...params,
    ...(params.tools
      ? {
          tools: params.tools.map((definition) =>
            definition.type === "function"
              ? { ...definition, name: encodeToolName(definition.name, encoding) }
              : definition,
          ),
        }
      : {}),
    ...(params.toolChoice?.type === "tool"
      ? {
          toolChoice: {
            ...params.toolChoice,
            toolName: encodeToolName(params.toolChoice.toolName, encoding),
          },
        }
      : {}),
    prompt: params.prompt.map((message) => encodePromptMessage(message, encoding)),
  };
}

function decodeContentPart(part: ContentPart, encoding: ToolNameEncoding): ContentPart {
  if (
    (part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request") &&
    "toolName" in part
  ) {
    return { ...part, toolName: decodeToolName(part.toolName, encoding) };
  }
  return part;
}

function decodeStreamPart(part: StreamPart, encoding: ToolNameEncoding): StreamPart {
  if (
    (part.type === "tool-input-start" ||
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request") &&
    "toolName" in part
  ) {
    return { ...part, toolName: decodeToolName(part.toolName, encoding) };
  }
  return part;
}

function toolNameMiddleware(encoding: ToolNameEncoding): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => encodeParams(params, encoding),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      return {
        ...result,
        content: result.content.map((part) => decodeContentPart(part, encoding)),
      };
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform: (chunk, controller) => controller.enqueue(decodeStreamPart(chunk, encoding)),
          }),
        ),
      };
    },
  };
}

declare const providerAdaptedModel: unique symbol;
export type ProviderAdaptedLanguageModel = LanguageModelV4 & {
  readonly [providerAdaptedModel]: true;
};

/**
 * Probe/test seam for wrapping an injected concrete model. Production route
 * construction goes through createProviderModel so model id and implementation
 * cannot disagree.
 */
export function withProviderAdapter(modelId: ModelId, model: LanguageModelV4): LanguageModelV4 {
  const provider = MODEL_REGISTRY[modelId];
  const adapter = adapterForModel(modelId);
  const actualProvider = normalizeProvider(model.provider);
  if (actualProvider !== provider || model.modelId !== modelId) {
    throw new Error(
      `${modelId} protocol cannot wrap ${actualProvider}/${model.modelId}; expected ${provider}/${modelId}`,
    );
  }
  const named = wrapLanguageModel({
    model,
    middleware: toolNameMiddleware(adapter.toolNameEncoding),
  });
  return wrapLanguageModel({
    model: named,
    middleware: middlewareFor(modelId),
  });
}

/** Construct one fully wrapped concrete model from Alfred's closed registry. */
export function createProviderModel(modelId: ModelId): LanguageModelV4 {
  const adapter = adapterForModel(modelId);
  return withProviderAdapter(modelId, adapter.createModel(modelId));
}

export type ModelReasoningPolicy = EffortLevel | "disabled";

/** Resolve one model's complete provider-namespaced reasoning block. */
export function providerOptionsForModel(
  modelId: ModelId,
  reasoning: ModelReasoningPolicy,
): ProviderOptions {
  const provider = MODEL_REGISTRY[modelId];
  const adapter = adapterForModel(modelId);
  const options =
    reasoning === "disabled"
      ? adapter.disabledReasoningOptions(modelId)
      : adapter.reasoningOptions(modelId, reasoning);
  return { [provider]: options };
}

/**
 * Compose an adapted route inside the module that owns the brand. Every
 * concrete leg crosses the provider seam before product fallback/default
 * wrappers are applied, and the brand is restored once at the outer route seam.
 */
export function createProviderRouteModel(
  chain: readonly [ModelId, ...ModelId[]],
  composeFallback: (primary: LanguageModelV4, fallback: LanguageModelV4) => LanguageModelV4,
  defaultProviderOptions?: ProviderOptions,
): ProviderAdaptedLanguageModel {
  let model: LanguageModelV4 = createProviderModel(chain[0]);
  for (const modelId of chain.slice(1)) {
    model = composeFallback(model, createProviderModel(modelId));
  }
  if (defaultProviderOptions) {
    model = wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: defaultProviderOptions },
      }),
    });
  }
  return model as ProviderAdaptedLanguageModel;
}
