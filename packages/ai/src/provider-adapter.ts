import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { GoogleProvider } from "@ai-sdk/google";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { activeGateway } from "./gateway";
import { normalizeProvider, type ModelObject, type ProviderId } from "./models";
import {
  cleanProviderRequest,
  projectAnthropicRequest,
  projectApplicationRequest,
} from "./request-projection";
import type { CacheTtl } from "./request-projection";
import { codecForProvider } from "./tool-name-codec";

export { attachProviderTurnPolicy } from "./request-projection";

export type { CacheTtl } from "./request-projection";

/** Provider-neutral reasoning level. Each provider package maps it to its own options. */
export type RouteReasoning = NonNullable<LanguageModelV4CallOptions["reasoning"]>;

/** The factory's model-id literals without the `(string & {})` escape, so a typo fails to compile. */
type KnownModelId<T> = T extends string ? (string extends T ? never : T) : never;

type AnthropicModelId = KnownModelId<Parameters<AnthropicProvider>[0]>;

type GoogleModelId = KnownModelId<Parameters<GoogleProvider>[0]>;

type OpenAiModelId = KnownModelId<Parameters<OpenAIProvider["responses"]>[0]>;

// Only Anthropic needs its own projection, for cache placement.
type RequestProjection = (
  params: LanguageModelV4CallOptions,
  cacheTtl: CacheTtl | undefined,
) => LanguageModelV4CallOptions;

const PROJECTIONS = {
  anthropic: projectAnthropicRequest,
  google: projectApplicationRequest,
  openai: projectApplicationRequest,
} as const satisfies Record<ProviderId, RequestProjection>;

function middlewareFor(provider: ProviderId): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      const { clean, cacheTtl } = cleanProviderRequest(params);

      return PROJECTIONS[provider](clean, cacheTtl);
    },
  };
}

// Tool names are encoded on the way to the provider and decoded on the way back.
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelV4Middleware["wrapGenerate"]>>>;

type ContentPart = GenerateResult["content"][number];

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelV4Middleware["wrapStream"]>>>;

type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

type PromptMessage = LanguageModelV4CallOptions["prompt"][number];

type MessagePart = Extract<PromptMessage["content"], readonly unknown[]>[number];

function encodeMessagePart<Part extends MessagePart>(
  part: Part,
  encode: (s: string) => string,
): Part {
  if ((part.type === "tool-call" || part.type === "tool-result") && "toolName" in part) {
    return { ...part, toolName: encode(part.toolName) };
  }

  return part;
}

function encodePromptMessage<Message extends PromptMessage>(
  message: Message,
  encode: (s: string) => string,
): Message {
  const content = message.content;

  if (!Array.isArray(content)) return message;

  return {
    ...message,
    content: content.map((part) => encodeMessagePart(part, encode)),
  };
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
    transformParams: async ({ params }) => encodeParams(params, encode),
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

/**
 * Stamp the leg's model id on a result that has none. `@ai-sdk/google` never reports one,
 * so without this a fallback to Google is priced as the primary (see {@link routeLegProviders}).
 * A provider's own id wins. A missing stream part is added only for Google, which can send none.
 */
function servedModelIdMiddleware(modelId: string, provider: ProviderId): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();

      if (result.response?.modelId !== undefined) return result;

      return { ...result, response: { ...result.response, modelId } };
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      let seen = false;
      const synthesizeMissing = provider === "google";

      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform: (chunk, controller) => {
              if (chunk.type === "response-metadata") {
                seen = true;
                controller.enqueue(chunk.modelId === undefined ? { ...chunk, modelId } : chunk);

                return;
              }

              controller.enqueue(chunk);

              // Not in `flush`: the SDK reads the response at the terminal part, before close.
              if (synthesizeMissing && !seen) {
                seen = true;
                controller.enqueue({ type: "response-metadata", modelId });
              }
            },
          }),
        ),
      };
    },
  };
}

/** One route leg. Only `adaptProviderModel` makes one, so every leg is validated. */
export interface RouteLeg {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly model: LanguageModelV4;
}

/**
 * Attach Alfred's adapter to a provider model. Throws if the model is from another provider.
 * Wrap order, inside out: model-id stamp, tool names, projection. The stamp must sit
 * next to the real model so it names one leg.
 */
export function adaptProviderModel(provider: ProviderId, model: LanguageModelV4): RouteLeg {
  const codec = codecForProvider(provider);
  const actualProvider = normalizeProvider(model.provider);

  if (actualProvider !== provider) {
    throw new Error(`cannot attach the ${provider} protocol to ${actualProvider}/${model.modelId}`);
  }

  const stamped = wrapLanguageModel({
    model,
    middleware: servedModelIdMiddleware(model.modelId, provider),
  });

  const named = wrapLanguageModel({
    model: stamped,
    middleware: toolNameMiddleware(codec.encode, codec.decode),
  });

  const composed = wrapLanguageModel({
    model: named,
    middleware: middlewareFor(provider),
  });

  return { provider, modelId: model.modelId, model: composed };
}

export function anthropicLeg(modelId: AnthropicModelId): RouteLeg {
  return adaptProviderModel("anthropic", activeGateway().createAnthropic()(modelId));
}

export function googleLeg(modelId: GoogleModelId): RouteLeg {
  return adaptProviderModel("google", activeGateway().createGoogle()(modelId));
}

/**
 * `store: false` on every OpenAI leg (ADR-0077). Unified Billing is a Zero Data Retention org,
 * so replaying a reasoning item by `rs_…` id returns 400.
 */
export function openAiLeg(modelId: OpenAiModelId): RouteLeg {
  const leg = adaptProviderModel("openai", activeGateway().createOpenAI().responses(modelId));

  const model = wrapLanguageModel({
    model: leg.model,
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions: { openai: { store: false } } },
    }),
  });

  return { ...leg, model };
}

/** Default `reasoning`; an explicit caller value wins. `defaultSettingsMiddleware` cannot set it. */
function reasoningMiddleware(reasoning: RouteReasoning): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => {
      return params.reasoning === undefined ? { ...params, reasoning } : params;
    },
  };
}

export interface RouteModelSettings {
  readonly reasoning: RouteReasoning;
  /** What the generic reasoning setting cannot express. */
  readonly providerOptions?: SharedV4ProviderOptions;
}

/**
 * The served-model rule. Two facts, both required, or a fallback call is priced wrong:
 * 1. The composed model always reports the primary leg; `wrapLanguageModel` copies
 *    `provider` and `modelId` once.
 * 2. `result.response.modelId` names the leg that answered, because `servedModelIdMiddleware` stamps it.
 * This map turns that model id into its provider. Keyed by the final wrapped model.
 */
const routeLegProviders = new WeakMap<ModelObject, ReadonlyMap<string, string>>();

/** Pass `result.response.modelId`, never the route model's own `modelId`. */
export function providerForServedModel(
  routeModel: ModelObject,
  servedModelId: string,
): string | undefined {
  return routeLegProviders.get(routeModel)?.get(servedModelId);
}

/**
 * Chain the legs with `composeFallback` and set the route defaults.
 * ai-retry keys retry state on the facade's primary id, so a third leg would share
 * the primary's budget. Every route has two legs or fewer today.
 */
export function createProviderRouteModel(
  legs: readonly (() => RouteLeg)[],
  composeFallback: (primary: LanguageModelV4, fallback: LanguageModelV4) => LanguageModelV4,
  settings: RouteModelSettings,
): LanguageModelV4 {
  const [first, ...rest] = legs;

  if (!first) throw new Error("a model route needs at least one leg");

  const firstLeg = first();

  const legProviders = new Map<string, string>([[firstLeg.modelId, firstLeg.provider]]);

  let model: LanguageModelV4 = firstLeg.model;

  for (const makeLeg of rest) {
    const leg = makeLeg();

    // One model id under two providers is ambiguous, so drop it rather than guess.
    const existing = legProviders.get(leg.modelId);

    if (existing === undefined) {
      legProviders.set(leg.modelId, leg.provider);
    } else if (existing !== leg.provider) {
      legProviders.delete(leg.modelId);
    }

    model = composeFallback(model, leg.model);
  }

  if (settings.providerOptions) {
    model = wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: settings.providerOptions },
      }),
    });
  }

  model = wrapLanguageModel({ model, middleware: reasoningMiddleware(settings.reasoning) });
  routeLegProviders.set(model, legProviders);

  return model;
}
