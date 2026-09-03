import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { activeGateway } from "./gateway";
import {
  MODEL_CAPABILITIES,
  MODEL_IDS,
  MODEL_REGISTRY,
  type ModelId,
  type ModelIdFor,
  type ModelProviderId,
  normalizeProvider,
} from "./models";
import {
  cleanProviderRequest,
  projectAnthropicRequest,
  projectApplicationRequest,
} from "./request-projection";
import type { CacheTtl } from "./request-projection";
import { codecForProvider } from "./tool-name-codec";

// ── Re-exports preserving the public seam ──────────────────────────────────
export { attachProviderTurnPolicy } from "./request-projection";
export type { CacheTtl } from "./request-projection";
export type { ModelReasoningPolicy } from "./reasoning-policy";
export { providerOptionsForModel } from "./reasoning-policy";

// Thin adapter map — each entry delegates to a deep module instead of owning
// the implementation. No generic erasure: lookup is via MODEL_REGISTRY.
type ProviderSpec = {
  readonly nativeToolSearch: boolean;
  createModel(modelId: string): LanguageModelV4;
  projectRequest(
    params: LanguageModelV4CallOptions,
    cacheTtl: CacheTtl | undefined,
  ): LanguageModelV4CallOptions;
};

const PROVIDER_SPECS = {
  anthropic: {
    nativeToolSearch: false,
    createModel: (modelId: string) => {
      // SAFETY: PROVIDER_SPECS is keyed by ModelProviderId; each branch creates only its own provider's model type.
      return activeGateway().createAnthropic()(modelId as ModelIdFor<"anthropic">);
    },
    projectRequest: projectAnthropicRequest,
  },
  google: {
    nativeToolSearch: false,
    createModel: (modelId: string) => {
      // SAFETY: keyed by provider, so google branch only receives google ids.
      return activeGateway().createGoogle()(modelId as ModelIdFor<"google">);
    },
    projectRequest: projectApplicationRequest,
  },
  openai: {
    nativeToolSearch: false,
    createModel: (modelId: string) => {
      // SAFETY: openai branch only receives openai ids; .responses is the language-model factory.
      return activeGateway()
        .createOpenAI()
        .responses(modelId as ModelIdFor<"openai">);
    },
    projectRequest: projectApplicationRequest,
  },
} as const satisfies Record<ModelProviderId, ProviderSpec>;

const NATIVE_TOOL_LOADING_MODELS: ReadonlySet<ModelId> = new Set();

function specForModel(modelId: ModelId): ProviderSpec {
  return PROVIDER_SPECS[MODEL_REGISTRY[modelId]];
}

type ToolLoadingProtocol = "application" | "native";

function toolLoadingProtocolForModel(modelId: ModelId): ToolLoadingProtocol {
  return MODEL_CAPABILITIES[modelId].nativeToolSearch &&
    specForModel(modelId).nativeToolSearch &&
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
  // SAFETY: PROVIDER_SPECS is Record<ModelProviderId, ProviderSpec>, so entries are exactly these tuples.
  for (const [provider, spec] of Object.entries(PROVIDER_SPECS) as [
    ModelProviderId,
    ProviderSpec,
  ][]) {
    const reachable = MODEL_IDS.some(
      (modelId) =>
        MODEL_REGISTRY[modelId] === provider && MODEL_CAPABILITIES[modelId].nativeToolSearch,
    );
    if (spec.nativeToolSearch && !reachable) {
      throw new Error(`${provider} native tool-search adapter is unreachable`);
    }
  }
}

assertProtocolRegistry();

// ── Middleware: ordered chain [toolName (inner) ← projection (outer)] ────────
// Original nesting: withProviderAdapter did wrap(toolName) then wrap(projection).
// Outer (projection) sees the envelope and strips it, then inner encodes names.
// Order is load-bearing — preserved here explicitly.

function middlewareFor(modelId: ModelId): LanguageModelV4Middleware {
  const spec = specForModel(modelId);
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      // SAFETY: params is LanguageModelV4CallOptions (the owning type); the param is widened via LanguageModelMiddleware in ai.
      const { clean, cacheTtl } = cleanProviderRequest(params as LanguageModelV4CallOptions);
      return spec.projectRequest(clean, cacheTtl);
    },
  };
}

// Provider-boundary name transform
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelV4Middleware["wrapGenerate"]>>>;
type ContentPart = GenerateResult["content"][number];
type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelV4Middleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type PromptMessage = LanguageModelV4CallOptions["prompt"][number];
type MessagePart = Extract<PromptMessage["content"], readonly unknown[]>[number];

function encodeMessagePart(part: MessagePart, encode: (s: string) => string): MessagePart {
  if ((part.type === "tool-call" || part.type === "tool-result") && "toolName" in part) {
    return { ...part, toolName: encode(part.toolName) };
  }
  return part;
}

function encodePromptMessage(message: PromptMessage, encode: (s: string) => string): PromptMessage {
  if (!Array.isArray(message.content)) return message;
  // SAFETY: encodeMessagePart preserves the PromptMessage content-part union; mapping keeps PromptMessage.
  return {
    ...message,
    content: message.content.map((part) => encodeMessagePart(part, encode)),
  } as PromptMessage;
}

function encodeParams(
  params: LanguageModelV4CallOptions,
  encode: (s: string) => string,
): LanguageModelV4CallOptions {
  return {
    ...params,
    ...(params.tools
      ? {
          tools: params.tools.map((definition) =>
            definition.type === "function"
              ? { ...definition, name: encode(definition.name) }
              : definition,
          ),
        }
      : {}),
    ...(params.toolChoice?.type === "tool"
      ? {
          toolChoice: {
            ...params.toolChoice,
            toolName: encode(params.toolChoice.toolName),
          },
        }
      : {}),
    prompt: params.prompt.map((message) => encodePromptMessage(message, encode)),
  };
}

function decodeContentPart(part: ContentPart, decode: (s: string) => string): ContentPart {
  if (
    (part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request") &&
    "toolName" in part
  ) {
    return { ...part, toolName: decode(part.toolName) };
  }
  return part;
}

function decodeStreamPart(part: StreamPart, decode: (s: string) => string): StreamPart {
  if (
    (part.type === "tool-input-start" ||
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request") &&
    "toolName" in part
  ) {
    return { ...part, toolName: decode(part.toolName) };
  }
  return part;
}

function toolNameMiddleware(
  encode: (s: string) => string,
  decode: (s: string) => string,
): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) =>
      // SAFETY: ai's LanguageModelMiddleware widens params; the owning type is LanguageModelV4CallOptions.
      encodeParams(params as LanguageModelV4CallOptions, encode),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      return {
        ...result,
        content: result.content.map((part) => decodeContentPart(part, decode)),
      };
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform: (chunk, controller) => controller.enqueue(decodeStreamPart(chunk, decode)),
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

export function withProviderAdapter(modelId: ModelId, model: LanguageModelV4): LanguageModelV4 {
  const provider = MODEL_REGISTRY[modelId];
  const codec = codecForProvider(provider);
  const actualProvider = normalizeProvider(model.provider);
  if (actualProvider !== provider || model.modelId !== modelId) {
    throw new Error(
      `${modelId} protocol cannot wrap ${actualProvider}/${model.modelId}; expected ${provider}/${modelId}`,
    );
  }
  const named = wrapLanguageModel({
    model,
    middleware: toolNameMiddleware(codec.encode, codec.decode),
  });
  return wrapLanguageModel({
    model: named,
    middleware: middlewareFor(modelId),
  });
}

export function createProviderModel(modelId: ModelId): LanguageModelV4 {
  const spec = specForModel(modelId);
  return withProviderAdapter(modelId, spec.createModel(modelId));
}

export function createProviderRouteModel(
  chain: readonly [ModelId, ...ModelId[]],
  composeFallback: (primary: LanguageModelV4, fallback: LanguageModelV4) => LanguageModelV4,
  defaultProviderOptions?: SharedV4ProviderOptions,
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
  // SAFETY: model is LanguageModelV4 composed entirely from createProviderModel / composeFallback; brand minted once here at the outer route seam.
  return model as ProviderAdaptedLanguageModel;
}
