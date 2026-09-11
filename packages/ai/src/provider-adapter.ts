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
import { normalizeProvider, type ProviderId } from "./models";
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

/**
 * Provider-neutral reasoning ceiling a product route selects. The concrete
 * provider package maps or clamps it for the model that actually serves
 * (`@ai-sdk/anthropic` thinking budgets/effort, `@ai-sdk/google` thinking
 * levels/budgets, `@ai-sdk/openai` reasoning effort). Alfred keeps no parallel
 * effort vocabulary of its own.
 */
export type RouteReasoning = NonNullable<LanguageModelV4CallOptions["reasoning"]>;

/**
 * The provider factory's known model-id union with its `(string & {})` escape
 * hatch stripped. The SDK keeps that hatch so a caller can pass a preview id it
 * has not catalogued yet; Alfred does not want it, because it also admits a typo
 * that should fail at compile time. Distributing the conditional drops the
 * `string`-accepting member to `never` and keeps every literal. Deriving from
 * the installed factory, so a provider upgrade moves the accepted ids with it.
 */
type KnownModelId<T> = T extends string ? (string extends T ? never : T) : never;

type AnthropicModelId = KnownModelId<Parameters<AnthropicProvider>[0]>;

type GoogleModelId = KnownModelId<Parameters<GoogleProvider>[0]>;

type OpenAiModelId = KnownModelId<Parameters<OpenAIProvider["responses"]>[0]>;

// ── Provider projections ───────────────────────────────────────────────────
// Each provider owns only the Alfred policy its package does not: cache
// placement for Anthropic; envelope removal is provider-neutral and happens
// before the projection runs.
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

// ── Provider-boundary name transform ───────────────────────────────────────
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

// ── Adapter attachment ─────────────────────────────────────────────────────
// Ordered chain [toolName (inner) ← projection (outer)]: the outer projection
// strips the internal envelope and decorates for the provider, the inner name
// shim encodes only the final function-tool set and leaves provider-defined
// tools alone. Order is load-bearing.

/**
 * Attach the matching Alfred adapter to a model the provider package already
 * constructed. The provider is read off the model object, never a registry, and
 * the call fails loudly on a mismatch so an adapter cannot decorate the wrong
 * provider's request.
 */
export function adaptProviderModel(provider: ProviderId, model: LanguageModelV4): LanguageModelV4 {
  const codec = codecForProvider(provider);
  const actualProvider = normalizeProvider(model.provider);

  if (actualProvider !== provider) {
    throw new Error(`cannot attach the ${provider} protocol to ${actualProvider}/${model.modelId}`);
  }

  const named = wrapLanguageModel({
    model,
    middleware: toolNameMiddleware(codec.encode, codec.decode),
  });

  return wrapLanguageModel({
    model: named,
    middleware: middlewareFor(provider),
  });
}

/** Construct an Anthropic leg with its adapter attached. */
export function anthropicLeg(modelId: AnthropicModelId): LanguageModelV4 {
  return adaptProviderModel("anthropic", activeGateway().createAnthropic()(modelId));
}

/** Construct a Google leg with its adapter attached. */
export function googleLeg(modelId: GoogleModelId): LanguageModelV4 {
  return adaptProviderModel("google", activeGateway().createGoogle()(modelId));
}

/**
 * Construct an OpenAI Responses leg with its adapter attached. Every OpenAI leg
 * carries `store: false` and the reason is reasoning-item retention rather than
 * privacy: Cloudflare Unified Billing puts Alfred on a Zero Data Retention org,
 * so replaying a reasoning item by `rs_…` id 400s and kills the turn. See the
 * longer note in the removed `reasoning-policy.ts` history and ADR-0077.
 */
export function openAiLeg(modelId: OpenAiModelId): LanguageModelV4 {
  const model = adaptProviderModel("openai", activeGateway().createOpenAI().responses(modelId));

  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions: { openai: { store: false } } },
    }),
  });
}

/**
 * Install the route's generic reasoning ceiling as a default — a caller that
 * sets `reasoning` explicitly still wins. `defaultSettingsMiddleware` owns the
 * other call settings but its options type omits `reasoning`, so this is the
 * narrow seam that carries the provider-neutral value.
 */
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
  /** Alfred's provider-option exceptions the generic reasoning setting cannot express. */
  readonly providerOptions?: SharedV4ProviderOptions;
}

/**
 * Compose a route's legs — constructed in order, each through its own provider
 * factory and adapter — then install the route's reasoning ceiling and provider
 * exceptions as overridable defaults.
 */
export function createProviderRouteModel(
  legs: readonly (() => LanguageModelV4)[],
  composeFallback: (primary: LanguageModelV4, fallback: LanguageModelV4) => LanguageModelV4,
  settings: RouteModelSettings,
): LanguageModelV4 {
  const [first, ...rest] = legs;

  if (!first) throw new Error("a model route needs at least one leg");
  let model: LanguageModelV4 = first();

  for (const makeLeg of rest) {
    model = composeFallback(model, makeLeg());
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

  return model;
}
