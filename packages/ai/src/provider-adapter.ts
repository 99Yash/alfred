import type { AnthropicProvider } from "@ai-sdk/anthropic";
import type { GoogleProvider } from "@ai-sdk/google";
import type { OpenAIProvider } from "@ai-sdk/openai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import type { LanguageModel as SdkLanguageModel } from "ai";
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

/**
 * Stamp the leg's own model id onto a result the provider left unstamped.
 *
 * Without this, served-model attribution cannot fire on any Google leg, which
 * is every degrade leg Alfred has. `@ai-sdk/google` fills `response` with
 * `{ id }` alone — its source carries a literal `// TODO timestamp, model id` —
 * and its stream emits `response-metadata` with `{ id }` for the same reason.
 * `ai` then resolves the step as `result.response?.modelId ?? stepModel.modelId`,
 * and on a composed route `stepModel` is the facade, frozen at the PRIMARY leg
 * (see {@link routeLegProviders}). So a degraded call reported the primary's
 * id, the meter saw no divergence, and the turn was priced against the wrong
 * `model_prices` row.
 *
 * Alfred owns this seam per leg and knows which model the leg is, so it fills
 * the gap the provider left. A provider that reports its own id keeps it,
 * including a dated alias echo — attribution already handles that. The stream
 * arm also SYNTHESIZES a `response-metadata` part when the provider emits none
 * at all, which Google does whenever the response carries no `responseId`.
 */
function servedModelIdMiddleware(modelId: string): LanguageModelV4Middleware {
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

              // After the first part rather than in `flush`: the SDK reads the
              // step's response when the model's terminal part arrives, so a
              // part enqueued at close is too late. An id the provider sends
              // later still wins, because the SDK merges field by field.
              if (!seen) {
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

// ── Adapter attachment ─────────────────────────────────────────────────────
// Ordered chain [served-model stamp (innermost) ← toolName ← projection
// (outermost)]: the outer projection strips the internal envelope and decorates
// for the provider, the name shim encodes only the final function-tool set and
// leaves provider-defined tools alone, and the innermost stamp labels the
// result with the leg that produced it. Order is load-bearing — the stamp must
// sit closest to the real model so it names one leg, never a composition.

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

  const stamped = wrapLanguageModel({
    model,
    middleware: servedModelIdMiddleware(model.modelId),
  });

  const named = wrapLanguageModel({
    model: stamped,
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
 * Any constructed SDK model object — the arm `LanguageModel` narrows to once a
 * bare gateway model-id string is excluded. Wider than `LanguageModelV4`
 * because the SDK's own handle type still admits older specification versions,
 * and a caller holding one must be able to ask this question.
 */
type ModelObject = Exclude<SdkLanguageModel, string>;

/**
 * Which provider serves each model id a given route can degrade to.
 *
 * THIS DOCBLOCK IS THE ONE HOME OF THE SERVED-MODEL RULE. Every other site
 * that touches attribution — `servedModelIdMiddleware` above, `reconcileServed`
 * and `MeteredResult.served` in `./metering` — points here instead of
 * restating it, because the rule has moved twice already and a restated copy
 * does not move with it.
 *
 * The rule has two halves, and BOTH must hold or a degraded call is priced
 * against the wrong `model_prices` row.
 *
 * 1. Attribution cannot be read off the composed model object.
 *    `wrapLanguageModel` evaluates `provider` and `modelId` ONCE, at
 *    construction, into plain properties — it installs no getters — and
 *    `createProviderRouteModel` wraps every route unconditionally to carry the
 *    reasoning ceiling. So the composed model reports the primary leg forever,
 *    whichever leg actually answered. A probe over a fallback that returned
 *    text confirmed it: `result.response` named the Gemini leg while the model
 *    object still read `openai`.
 * 2. The SDK result carries the truth ONLY because Alfred puts it there.
 *    `ai` resolves a step as `result.response?.modelId ?? stepModel.modelId`,
 *    and `stepModel` is the frozen facade from (1) — so a provider that
 *    reports no model id, which `@ai-sdk/google` does on both its generate and
 *    its stream path, silently returns the primary's id and no divergence is
 *    ever seen. `servedModelIdMiddleware` stamps each leg's own id at
 *    construction to close that hole.
 *
 * The stamped result still carries a bare `modelId` with no provider beside
 * it. This map supplies the missing half from the legs the route was built
 * from, so no hand-written model-to-provider table is needed and an unknown id
 * resolves to nothing rather than to a guess. Keyed by the FINAL wrapped
 * object, because that is what call sites hold.
 */
const routeLegProviders = new WeakMap<ModelObject, ReadonlyMap<string, string>>();

/**
 * The provider that owns `servedModelId` on this route, or `undefined` when the
 * id belongs to no leg of it. Pair with `result.response.modelId`; never with
 * the route model's own `modelId`, which names the primary leg only.
 */
export function providerForServedModel(
  routeModel: ModelObject,
  servedModelId: string,
): string | undefined {
  return routeLegProviders.get(routeModel)?.get(servedModelId);
}

/**
 * Compose a route's legs — constructed in order, each through its own provider
 * factory and adapter — then install the route's reasoning ceiling and provider
 * exceptions as overridable defaults.
 *
 * The composed facade reports the PRIMARY leg's `provider`/`modelId`, and that
 * stays true at any leg count — `ai-retry`'s `getModelKey` reads those two
 * fields, so a three-leg route would key its retry state on the primary as
 * well. Harmless today because attribution runs off {@link routeLegProviders}
 * rather than off the facade, and because every route here has two legs or
 * fewer. Check that assumption before adding a third.
 */
export function createProviderRouteModel(
  legs: readonly (() => LanguageModelV4)[],
  composeFallback: (primary: LanguageModelV4, fallback: LanguageModelV4) => LanguageModelV4,
  settings: RouteModelSettings,
): LanguageModelV4 {
  const [first, ...rest] = legs;

  if (!first) throw new Error("a model route needs at least one leg");

  const firstLeg = first();

  const legProviders = new Map<string, string>([
    [firstLeg.modelId, normalizeProvider(firstLeg.provider)],
  ]);

  let model: LanguageModelV4 = firstLeg;

  for (const makeLeg of rest) {
    const leg = makeLeg();

    legProviders.set(leg.modelId, normalizeProvider(leg.provider));
    model = composeFallback(model, leg);
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
