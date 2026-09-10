import { google } from "@ai-sdk/google";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ChatModelTier } from "@alfred/contracts";
import { isCallerAbort } from "./abort";
import { APICallError, type ToolSet } from "ai";
// ai-retry's `LanguageModel` alias is `LanguageModelV4` — the concrete model
// instances our provider factories return, deliberately narrower than `ai`'s
// `LanguageModel` union (which also admits gateway string ids). Same narrowing
// warden does; see its packages/ai/src/models.ts.
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { createRetryableModel, error, or, timeout } from "ai-retry/language-model";
import {
  anthropicLeg,
  createProviderRouteModel,
  googleLeg,
  openAiLeg,
  type ProviderAdaptedLanguageModel,
  type RouteReasoning,
} from "./provider-adapter";

// Re-export so existing `@alfred/ai` consumers keep importing `ChatModelTier`
// from here; the literal itself is owned by `@alfred/contracts` (single source
// of truth shared with the web bundle, which can't import `@alfred/ai`).
export type { ChatModelTier };

// Owned by @ai-sdk/provider: `Record<string, JSONObject>` where each value is the provider's own
// `*LanguageModelOptions` shape. Replacing the hand-rolled `NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>`
// indirection from the original `provider-adapter.ts:CallOptions` alias.
export type ChatProviderOptions = SharedV4ProviderOptions;

export const MEDIA_INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
export type MediaInputModality = (typeof MEDIA_INPUT_MODALITIES)[number];

/**
 * The generic AI SDK `reasoning` maps to Google `thinkingLevel`/`thinkingBudget`
 * but never enables thought summaries. Alfred asks for them — the retired
 * `reasoning-policy.ts` always sent `includeThoughts: true` on a reasoning-on
 * Google leg — so a Google-bearing route with reasoning on carries this
 * provider-option exception: the Google analogue of Anthropic's package-owned
 * `display: "summarized"`. It rides on the whole route; non-Google primaries
 * ignore the namespace.
 */
const GOOGLE_THOUGHT_SUMMARIES = {
  google: { thinkingConfig: { includeThoughts: true } },
} as const satisfies SharedV4ProviderOptions;

interface ModelRoute {
  /** Leg makers, constructed in fallback order by their own provider factories. */
  readonly legs: readonly (() => LanguageModelV4)[];
  /** Generic AI SDK reasoning ceiling; the provider package maps/clamps it. */
  readonly reasoning: RouteReasoning;
  /** Provider-option exception the generic reasoning setting cannot express (e.g. OpenAI `max`). */
  readonly providerOptions?: SharedV4ProviderOptions;
}

/**
 * Product model routes. A route is the ordered leg list plus the reasoning
 * policy that travels with every leg. Every leg is constructed directly by its
 * installed provider package and carries its matching adapter; the model
 * object, not a second registry entry, supplies provider and model id.
 */
const MODEL_ROUTES = {
  boss: {
    legs: [() => anthropicLeg("claude-sonnet-4-6"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "medium",
    providerOptions: GOOGLE_THOUGHT_SUMMARIES,
  },
  // Sub-agents follow the chat tiers onto Luna (ADR-0077 amendment
  // 2026-09-03d) so a delegating chat turn is one vendor end to end. The July
  // bake-off measured the mixed pairing — Luna boss + Sonnet worker — as the
  // worst shape at 10 calls / 97s / $0.241, and a Sonnet worker still costs
  // 13× a Luna one. `boss` stays on Sonnet: it drives background work only.
  subAgent: {
    legs: [() => openAiLeg("gpt-5.6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "medium",
    providerOptions: GOOGLE_THOUGHT_SUMMARIES,
  },
  cheap: {
    legs: [() => googleLeg("gemini-2.5-flash-lite"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "none",
  },
  webSearch: {
    legs: [() => googleLeg("gemini-3.8-flash")],
    reasoning: "none",
  },
  compactor: {
    legs: [() => anthropicLeg("claude-sonnet-4-6")],
    reasoning: "none",
  },
  compactorFallback: {
    legs: [() => googleLeg("gemini-3.8-flash")],
    reasoning: "none",
  },
  // Both chat tiers run `gpt-5.6-luna` and differ only in effort (ADR-0077
  // amendment 2026-09-03d). The 2026-09-02 `db:sync-prices` run cut Luna 5×
  // on every token class (1.00/6.00 → 0.20/1.20 per MTok), taking its blended
  // rate at Alfred's 7:2:1 cache/input/output mix to $0.174 against Sonnet's
  // $2.31 and Opus's $3.85. Anthropic leaves the chat tiers entirely: keeping
  // Sonnet as the Auto fallback made a degrade leg cost 13× the primary and
  // kept the Anthropic cache warm for nothing. `gemini-3.8-flash` is the
  // cross-provider degrade leg on both tiers, as it already is on boss, deep,
  // and cheap. Latency is the open risk pricing cannot fix: Luna ran 13 calls
  // / 63s against Sonnet's 4 / 28s, and the first live Auto turn took 16 legs
  // / 86s.
  standard: {
    legs: [() => openAiLeg("gpt-5.6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "medium",
    providerOptions: GOOGLE_THOUGHT_SUMMARIES,
  },
  // Deep is the same model at its strongest effort. `xhigh` is the generic AI
  // SDK ceiling; the OpenAI leg pins the provider-only `max` value and the
  // Gemini leg maps `xhigh` to its own `high`.
  deep: {
    legs: [() => openAiLeg("gpt-5.6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "xhigh",
    providerOptions: { ...GOOGLE_THOUGHT_SUMMARIES, openai: { reasoningEffort: "max" } },
  },
} as const satisfies Record<string, ModelRoute>;

export type ModelRouteName = keyof typeof MODEL_ROUTES;

export interface ModelRouteHandle {
  model(): ProviderAdaptedLanguageModel;
  /** Alfred's provider-option exceptions; the generic reasoning rides on the model defaults. */
  providerOptions(): ChatProviderOptions;
  /** The generic reasoning ceiling this route selects. */
  reasoning(): RouteReasoning;
}

function createRouteHandle(definition: ModelRoute): ModelRouteHandle {
  const providerOptions: ChatProviderOptions = definition.providerOptions ?? {};
  let model: ProviderAdaptedLanguageModel | undefined;
  return {
    model: () =>
      (model ??= createProviderRouteModel(definition.legs, withFallback, {
        reasoning: definition.reasoning,
        ...(definition.providerOptions ? { providerOptions: definition.providerOptions } : {}),
      })),
    providerOptions: () => providerOptions,
    reasoning: () => definition.reasoning,
  };
}

const namedRouteHandles = new Map<ModelRouteName, ModelRouteHandle>();

/**
 * Resolve a named product route, or build a one-model probe/eval route from an
 * already-constructed, adapter-attached leg. The probe form takes the model
 * object so identity is read off the leg rather than reconstructed from a
 * handwritten model-to-provider table.
 */
export function route(name: ModelRouteName): ModelRouteHandle;
export function route(
  leg: ProviderAdaptedLanguageModel,
  reasoning: RouteReasoning,
): ModelRouteHandle;
export function route(
  nameOrLeg: ModelRouteName | ProviderAdaptedLanguageModel,
  reasoning?: RouteReasoning,
): ModelRouteHandle {
  if (typeof nameOrLeg === "string") {
    let handle = namedRouteHandles.get(nameOrLeg);
    if (!handle) {
      handle = createRouteHandle(MODEL_ROUTES[nameOrLeg]);
      namedRouteHandles.set(nameOrLeg, handle);
    }
    return handle;
  }
  if (!reasoning) throw new Error("a one-model probe route needs a reasoning policy");
  return createRouteHandle({ legs: [() => nameOrLeg], reasoning });
}

interface MediaEnrichmentLeg {
  readonly modalities: readonly MediaInputModality[];
  readonly maxInlineBytes: number;
  readonly make: () => ProviderAdaptedLanguageModel;
}

/**
 * Inline attachment ceilings: the largest payload each provider reads natively
 * before Alfred must degrade it to text. Alfred product policy, not a model
 * registry — the provider package still owns how the model reads the bytes.
 */
const GOOGLE_INLINE_MEDIA_BYTES = 50 * 1024 * 1024;
const ANTHROPIC_INLINE_MEDIA_BYTES = 32 * 1024 * 1024;

/**
 * Ordered multimodal legs, filtered before any provider receives the payload.
 * These are Alfred product policy (which leg attempts a given attachment), not
 * a second model-mechanics catalog: the provider package still owns how the
 * model reads the bytes. The order is the enrichment attempt order.
 */
const MEDIA_ENRICHMENT_LEGS: readonly MediaEnrichmentLeg[] = [
  {
    modalities: ["text", "image", "audio", "video", "pdf"],
    maxInlineBytes: GOOGLE_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(googleLeg("gemini-3.8-flash")),
  },
  {
    modalities: ["text", "image", "audio", "video"],
    maxInlineBytes: GOOGLE_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(googleLeg("gemini-2.5-flash")),
  },
  {
    modalities: ["text", "image", "audio", "video", "pdf"],
    maxInlineBytes: GOOGLE_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(googleLeg("gemini-2.5-flash-lite")),
  },
  {
    modalities: ["text", "image", "pdf"],
    maxInlineBytes: ANTHROPIC_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(anthropicLeg("claude-sonnet-4-6")),
  },
];

/**
 * Select the generic `none` ceiling. The provider package maps it to the
 * generation's closest-to-off value: Gemini 2.5 gets `thinkingBudget: 0`, while
 * Gemini 3 can only reach `thinkingLevel: "minimal"` — the package documents
 * that full disable is unavailable there. The retired policy's `thinkingBudget:
 * 0` for a Gemini 3 model was a shape that generation does not own; this is the
 * SDK-owned equivalent, not a new budget.
 */
function withDisabledReasoning(leg: ProviderAdaptedLanguageModel): ProviderAdaptedLanguageModel {
  return createProviderRouteModel([() => leg], withFallback, { reasoning: "none" });
}

/** Ordered multimodal route legs for a payload, filtered by modality and inline size. */
export function getMediaEnrichmentModels(
  modality: MediaInputModality,
  byteSize: number,
): ProviderAdaptedLanguageModel[] {
  if (!Number.isInteger(byteSize) || byteSize < 0) throw new Error("byteSize must be non-negative");
  const models = MEDIA_ENRICHMENT_LEGS.filter(
    (leg) => leg.modalities.includes(modality) && byteSize <= leg.maxInlineBytes,
  ).map((leg) => leg.make());
  if (models.length === 0) throw new Error("media_enrichment_input_unsupported");
  return models;
}

/**
 * Provider tool set that turns on live Google Search grounding. Pass into the
 * `tools` field of a `meteredGenerateText` call alongside
 * `route("webSearch").model()`; the model searches server-side and returns a
 * grounded answer with source uris + citation spans under
 * `providerMetadata.google.groundingMetadata`.
 */
export function googleSearchGroundingTools(): ToolSet {
  // The SDK over-narrows a provider tool's input schema to `never` inside the
  // non-generic `ToolSet`, so the concrete grounding tool needs a cast — the
  // same `as ToolSet` shape `resolveSdkTools` uses for our function tools.
  // SAFETY: the built object is one SDK provider tool under its own key, which
  // is exactly the ToolSet record shape.
  return { google_search: google.tools.googleSearch({}) } as ToolSet;
}

/**
 * Wrap a primary model so a failed call degrades to `fallback` (warden's
 * `createRetryable` pattern — memory `feedback_ai_retry_preference`; the
 * earlier V2/V3 spec-mismatch blocker cleared with `@ai-sdk/*@3.0.x`, which
 * emit `LanguageModelV4`).
 *
 * Cascade, evaluated per failed attempt:
 *   1. Transient errors (provider-flagged retryable — 429/529/overload — or
 *      timeout) retry the primary once after a short delay, honoring
 *      `Retry-After` headers.
 *   2. Anything else switches to `fallback` for a single attempt — EXCEPT a
 *      non-retryable 4xx client error, which means OUR request is malformed
 *      (e.g. an illegal tool name) rather than the provider being down.
 *      Switching providers on a 4xx just hides the bug behind a weaker model:
 *      that is exactly how the dotted-tool-name 400 silently ran the chat boss
 *      on Gemini for weeks. A 4xx (other than 408/429, which are transient and
 *      a legit reason to try the other provider) now surfaces loudly instead.
 *      A caller-initiated abort is excluded for a different reason: the request
 *      was cancelled on purpose, so there is nothing to degrade to.
 *
 * Streaming caveat: fallback only covers errors raised before the stream
 * starts; a provider dying mid-stream after tokens flowed is not replayable.
 *
 * Attribution: the returned model proxies `provider`/`modelId` to whichever
 * model is *currently* serving, and after the call the metering layer reads
 * that pair off the model object (`served` in `MeteredResult`), so
 * `api_call_log` stays correct when the fallback fires.
 */
/**
 * True when a 4xx is a billing/quota *capacity* condition (a workspace spend
 * cap, exhausted credits, or a usage-limit ceiling) rather than a malformed
 * request. Anthropic surfaces the workspace spend cap as a 400 whose body
 * carries the signature message "...workspace API usage limits..."; out-of-
 * credit and usage-limit errors read similarly ("credit balance is too low",
 * "usage limit"). These should degrade to the fallback like a 429, not
 * hard-fail the turn (#303).
 *
 * Matches defensively across the parsed message and the raw response body so a
 * provider tweak to either field still trips the carve-out, and the phrases are
 * specific enough not to catch a request-shape 4xx (illegal tool name, bad
 * schema), which must keep surfacing loudly.
 */
function isQuotaOrBillingError(e: APICallError): boolean {
  const haystack = `${e.message} ${e.responseBody ?? ""}`.toLowerCase();
  return (
    haystack.includes("usage limit") ||
    haystack.includes("credit balance") ||
    haystack.includes("billing")
  );
}

export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModelV4 {
  // True for any error worth degrading to the fallback; false for a
  // non-retryable client bug we want to surface. Built with the raw `error`
  // helper (not `.not()`) so it is inherently error-only — `.not()` of an error
  // condition also matches *successful* results, which the retry loop consults.
  const shouldSwitch = error((e) => {
    // A caller-initiated cancel is never a capacity condition — the request was
    // abandoned deliberately (a hedged-request loser, a stop button, shutdown),
    // so re-issuing it on the fallback bills a second call for an answer nobody
    // is waiting for. Without this, the triage hedge (#436) would have made
    // every cancelled duplicate fan out to `gemini-2.5-flash`.
    if (isCallerAbort(e)) return false;
    if (APICallError.isInstance(e) && e.statusCode !== undefined) {
      const code = e.statusCode;
      const isClientBug = code >= 400 && code < 500 && code !== 408 && code !== 429;
      // A spend-cap / workspace-usage-limit error is a *capacity* condition we
      // want to degrade through, but Anthropic returns it as a 4xx billing
      // error (not 408/429), so the generic client-bug guard would surface it
      // and hard-fail the turn (#303). Carve it out so it degrades like a 429,
      // while genuine request-shape 4xx (dotted tool name, malformed schema)
      // still surface loudly.
      if (isClientBug && !isQuotaOrBillingError(e)) return false;
    }
    return true;
  });
  return createRetryableModel({
    model: primary,
    retries: [
      or(error.isRetryable(true), timeout()).retry({ delay: 1_000, maxAttempts: 2 }),
      shouldSwitch.switch({ model: fallback }),
    ],
  });
}
