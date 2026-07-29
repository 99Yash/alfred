import { google, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { ChatModelTier } from "@alfred/contracts";
import { isCallerAbort } from "./abort";
import {
  APICallError,
  defaultSettingsMiddleware,
  generateText,
  wrapLanguageModel,
  type LanguageModel,
  type ToolSet,
} from "ai";
// ai-retry's `LanguageModel` alias is `LanguageModelV4` — the concrete model
// instances our provider factories return, deliberately narrower than `ai`'s
// `LanguageModel` union (which also admits gateway string ids). Same narrowing
// warden does; see its packages/ai/src/models.ts.
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { createRetryableModel, error, or, timeout } from "ai-retry/language-model";
import { type EffortLevel, MODEL_CAPABILITIES, type ModelId } from "./models";
import { createProviderModel, providerOptionsForModel } from "./provider-adapter";

// Re-export so existing `@alfred/ai` consumers keep importing `ChatModelTier`
// from here; the literal itself is owned by `@alfred/contracts` (single source
// of truth shared with the web bundle, which can't import `@alfred/ai`).
export type { ChatModelTier };

type ChatProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
const modelForId = createProviderModel;

/** Construct any language model in Alfred's closed registry. */
export function getRegisteredModel(id: ModelId): LanguageModel {
  return modelForId(id);
}

/** Provider-namespaced reasoning options for an explicitly selected registry model. */
export function getRegisteredModelProviderOptions(
  id: ModelId,
  effort: EffortLevel,
): ChatProviderOptions {
  const { provider, options } = providerOptionsForModel(id, effort);
  return { [provider]: options };
}

/**
 * Boss + sub-agent run on Anthropic Sonnet 4.6, degrading to Gemini 3.5 Flash
 * on provider failure via `withFallback`. (Restored 2026-06-07 after the
 * temporary 2026-05-21 → 2026-06-01 spend-cap swap to Gemini 2.5 Pro. Each
 * concrete model is protocol-wrapped before fallback composition, so Gemini
 * receives the application projection without Anthropic cache metadata.)
 */
export function getBossModel(): LanguageModel {
  return withFallback(modelForId("claude-sonnet-4-6"), modelForId("gemini-3.5-flash"));
}

export function getSubAgentModel(): LanguageModel {
  return withFallback(modelForId("claude-sonnet-4-6"), modelForId("gemini-3.5-flash"));
}

/**
 * Cheap-tier request default: **no thinking budget** (#436).
 *
 * `gemini-2.5-flash-lite` defaults thinking OFF, but its `withFallback` partner
 * `gemini-2.5-flash` defaults to *dynamic* thinking (`thinkingBudget: -1`), and
 * no cheap-path call site passes `providerOptions`. So every degraded cheap call
 * silently bought a reasoning budget for a short structured extraction — the 64
 * production fallback classify calls behind #436 averaged ~10s against a ~1.9s
 * median on the primary.
 *
 * Every cheap-tier consumer in the *product* path (triage classify, memory
 * extraction, the chat-memory extractor, cold-start extract, skills distill,
 * chat-turn titling) is a short schema-constrained extraction where thinking is
 * pure latency and pure spend, so this belongs on the tier rather than on one
 * caller. The one non-extraction consumer is an eval judge
 * (`voice-ai-tells.eval.ts`), which is unaffected in practice: it ran on the
 * budget-0 primary already, and the default is overridable below.
 *
 * Behaviour on the primary is unchanged (Flash-Lite is already budget-0); the
 * only path that moves is the degraded one.
 *
 * `defaultSettingsMiddleware` is `mergeObjects(settings, params)` — caller
 * params win — so this is a true default, not a ceiling: a cheap-path call that
 * ever *wants* thinking can still pass its own `thinkingConfig.thinkingBudget`
 * and override this.
 */
const CHEAP_TIER_DEFAULTS = defaultSettingsMiddleware({
  settings: {
    providerOptions: {
      // `satisfies` rather than a bare literal: `providerOptions` is an untyped
      // JSON bag, so a misspelled `thinkingConfig` would silently no-op — and a
      // test comparing the dispatch against the same misspelled literal would
      // still pass.
      google: {
        thinkingConfig: { thinkingBudget: 0 },
      } satisfies GoogleLanguageModelOptions,
    },
  },
});

/**
 * Apply {@link CHEAP_TIER_DEFAULTS} around a composed cheap-tier handle, so one
 * wrapper covers both the primary and the `withFallback` fallback (the fallback
 * is the model that actually needed it). `wrapLanguageModel`'s `doWrap` proxies
 * `provider`/`modelId` from the inner model, so `identifyLanguageModel` and the
 * served-model attribution (#216) still see the real Gemini ids.
 *
 * Exported as the seam its unit test drives (`cheap-tier-defaults.test.ts`
 * wraps a mock model and reads back the dispatched call options); production
 * code should take the composed handle from {@link getCheapModel}.
 */
export function withCheapTierDefaults(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    // `withFallback` always returns the concrete retryable model instance; its
    // declared type is only wider because `ai`'s `LanguageModel` union also
    // admits gateway model-id strings, which this package never constructs.
    model: model as LanguageModelV4,
    middleware: CHEAP_TIER_DEFAULTS,
  });
}

export function getCheapModel(): LanguageModel {
  // Flash-Lite is Google's lowest-latency tier — typical p50 is well under
  // a second for the short JSON outputs triage/extraction produce. Switched
  // from `gemini-2.5-flash` after the user flagged label-write lag on a
  // single inbound email; the larger Flash model was the bottleneck, not
  // the pipeline.
  //
  // Wrapped in `withFallback` like every other model getter so a flash-lite
  // capacity blip ("high demand" overload) degrades instead of throwing
  // `AI_RetryError`. Previously the only fallback-less getter: a sustained
  // overload hard-failed triage classification (and reddened the eval gate).
  //
  // Fallback is the larger SAME-PROVIDER tier (gemini-2.5-flash), NOT a
  // cross-provider Anthropic model. The cheap path runs `generateObject` over
  // a nested/optional schema, and Anthropic's structured-output (`Output.object`
  // → `output_config.format.schema`) handles that poorly: it rejects numeric
  // min/max and intermittently returns `AI_NoObjectGeneratedError` on
  // valid-looking JSON. Staying on Google keeps the structured-output mechanism
  // that already works; the bigger Flash pool absorbs flash-lite pressure.
  // (Boss/chat fall back cross-provider to Anthropic because they run
  // `generateText`, not structured object generation — different constraint.)
  return withCheapTierDefaults(
    withFallback(modelForId("gemini-2.5-flash-lite"), modelForId("gemini-2.5-flash")),
  );
}

const MEDIA_ENRICHMENT_ROUTES = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "claude-sonnet-4-6",
] as const satisfies readonly ModelId[];

export function mediaEnrichmentModelRoutes(
  modality: import("./models").MediaInputModality,
  byteSize: number,
): ModelId[] {
  if (!Number.isInteger(byteSize) || byteSize < 0) throw new Error("byteSize must be non-negative");
  return MEDIA_ENRICHMENT_ROUTES.filter((id) => {
    const capabilities = MODEL_CAPABILITIES[id];
    const inputModalities: readonly import("./models").MediaInputModality[] =
      capabilities.inputModalities;
    return inputModalities.includes(modality) && byteSize <= capabilities.maxInlineMediaBytes;
  });
}

/** Ordered multimodal routes, filtered before any provider receives the payload. */
export function getMediaEnrichmentModels(
  modality: import("./models").MediaInputModality,
  byteSize: number,
): LanguageModel[] {
  const routes = mediaEnrichmentModelRoutes(modality, byteSize);
  if (routes.length === 0) throw new Error("media_enrichment_input_unsupported");
  return routes.map(modelForId);
}

/**
 * Transcript compaction is rare, latency-tolerant, and quality-critical.
 * Keep it decoupled from the cheap tier: a bad handoff corrupts the rest
 * of a long boss run, while the incremental cost is negligible.
 */
export const COMPACTOR_MODEL: LanguageModel = modelForId("claude-sonnet-4-6");
export const COMPACTOR_FALLBACK_MODEL: LanguageModel = modelForId("gemini-2.5-flash");

/**
 * Live web-search model for short, agent-driven lookups.
 *
 * Switched 2026-06-12 from Perplexity Sonar Pro to grounded Gemini 2.5 Flash
 * (ADR-0022 amended): the Perplexity account lost billing, and Gemini ships
 * Google Search grounding on the API key we already hold. Flash keeps the
 * interactive lookup fast; grounding is turned on per-call by passing
 * {@link googleSearchGroundingTools} into the `tools` field.
 *
 * Caller must route through `meteredGenerateText` with
 * `attribution.kind = 'web_search'` so `api_call_log` rollups bucket the
 * spend correctly.
 */
export function getWebSearchModel(): LanguageModel {
  return modelForId("gemini-2.5-flash");
}

/**
 * Provider tool set that turns on live Google Search grounding. Pass into the
 * `tools` field of a `meteredGenerateText` call alongside
 * {@link getWebSearchModel}; the model searches server-side and returns a
 * grounded answer with source uris + citation spans under
 * `providerMetadata.google.groundingMetadata`.
 */
export function googleSearchGroundingTools(): ToolSet {
  // The SDK over-narrows a provider tool's input schema to `never` inside the
  // non-generic `ToolSet`, so the concrete grounding tool needs a cast — the
  // same `as ToolSet` shape `resolveSdkTools` uses for our function tools.
  return { google_search: google.tools.googleSearch({}) } as ToolSet;
}

/**
 * The interactive-chat tier table (ADR-0077): the product mapping of a tier to its
 * primary model, its cross-provider fallback, and the effort it requests. This is
 * the *only* place a tier's model is named — `getChatModel` and
 * `getChatProviderOptions` both read it, so the model and its reasoning block can
 * never drift (the #313 seam: a remap here flows into the dispatch automatically).
 *
 *   - `standard` (the Auto tier) → Claude Sonnet 4.6 — the everyday boss. ADR-0077
 *     originally downgraded this to Haiku 4.5 for cost, but the 2026-07-02 Sakshi
 *     production trace proved the prompt-patch strategy did not generalize: repeated
 *     "find more" turns, including a Deep/Opus turn, never reached the web. Auto is
 *     back on the same reasoning-capable model as sub-agents, with `effort: "medium"`
 *     as the latency-friendly default for the charter's model-judged source ladder.
 *   - `deep` → Claude Opus 4.8 — reserved for hard, multi-step turns (and the model
 *     the boss-worker harness runs on when chat fans out). Asks for `effort: "high"`
 *     for deliberate reasoning.
 *
 * Each tier degrades to Gemini 3.5 Flash on Anthropic failure (rate limit, overload,
 * spend cap) via `withFallback`, so a chat turn never hard-fails on a single
 * provider blip. The shared tier effort maps to Gemini's thinking level, keeping
 * Auto at medium and Deep at high instead of comparing unlike reasoning settings.
 */
const CHAT_TIERS = {
  standard: { primary: "claude-sonnet-4-6", fallback: "gemini-3.5-flash", effort: "medium" },
  deep: { primary: "claude-opus-4-8", fallback: "gemini-3.5-flash", effort: "high" },
} as const satisfies Record<
  ChatModelTier,
  { primary: ModelId; fallback: ModelId; effort: EffortLevel }
>;

export function getChatModel(tier: ChatModelTier = "standard"): LanguageModel {
  const { primary, fallback } = CHAT_TIERS[tier];
  return withFallback(modelForId(primary), modelForId(fallback));
}

/**
 * Build the chat model's reasoning block, namespaced per provider, so the stream
 * carries `reasoning-delta` parts the chat UI renders as a "Thinking…" accordion.
 * The SDK passes only the block matching the active model and ignores the rest, so
 * emitting both keeps it correct across the Anthropic⇆Gemini `withFallback` swap.
 *
 * Each block is built by the deep provider adapter map, reading
 * the resolved model's `effortValues`. The deleted tier-branch (ADR-0077's #313
 * seam) is now structural: `standard` resolves to Sonnet 4.6 with adaptive medium
 * effort; `deep` resolves to Opus with adaptive high effort. A future tier remap
 * flows through the same table and capability map instead of reintroducing a
 * provider-options branch.
 */
export function getChatProviderOptions(tier: ChatModelTier = "standard"): ChatProviderOptions {
  const { primary, fallback, effort } = CHAT_TIERS[tier];
  const options: ChatProviderOptions = {};
  for (const modelId of [primary, fallback]) {
    const { provider, options: next } = providerOptionsForModel(modelId, effort);
    const prev = options[provider];
    if (prev && JSON.stringify(prev) !== JSON.stringify(next)) {
      throw new Error(
        `${tier} maps multiple ${provider} chat models with incompatible provider options`,
      );
    }
    options[provider] = next;
  }
  return options;
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
 * model is *currently* serving, and the metering layer records the served
 * model from the response (`served` in `MeteredResult`), so `api_call_log`
 * stays correct when the fallback fires.
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

export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModel {
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
