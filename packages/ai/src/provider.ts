import { anthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { google, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { ChatModelTier } from "@alfred/contracts";
import { APICallError, type LanguageModel, type ToolSet } from "ai";
// ai-retry's `LanguageModel` alias is `LanguageModelV3` — the concrete model
// instances our provider factories return, deliberately narrower than `ai`'s
// `LanguageModel` union (which also admits gateway string ids). Same narrowing
// warden does; see its packages/ai/src/models.ts.
import type { LanguageModel as LanguageModelV3 } from "ai-retry";
import { createRetryable, error, timeout } from "ai-retry/experimental/language-model";
import type { ModelIdFor } from "./models";
import { withAnthropicToolNames } from "./tool-name-shim";

// Re-export so existing `@alfred/ai` consumers keep importing `ChatModelTier`
// from here; the literal itself is owned by `@alfred/contracts` (single source
// of truth shared with the web bundle, which can't import `@alfred/ai`).
export type { ChatModelTier };

// Provider factories constrained to ids that actually exist in MODEL_REGISTRY
// for that provider. Routing every `anthropic(...)`/`google(...)` literal
// through these makes registry drift (a typo, or an id the registry never
// listed) a compile error rather than a silent cost-attribution miss.
// Every Anthropic model is wrapped in the tool-name boundary shim so our dotted
// `integration.action` tool names survive Anthropic's pattern-validated API
// (which rejects the `.`); see `withAnthropicToolNames`. The shim is a no-op on
// tool-less calls, so routing the whole factory through it is safe and uniform.
const anthropicModel = (id: ModelIdFor<"anthropic">) => withAnthropicToolNames(anthropic(id));
const googleModel = (id: ModelIdFor<"google">) => google(id);

type AnthropicChatProviderOptions = Pick<AnthropicLanguageModelOptions, "thinking" | "effort">;
type GoogleChatProviderOptions = Pick<GoogleLanguageModelOptions, "thinkingConfig">;
type ChatProviderOptions = Record<string, Record<string, unknown>> & {
  anthropic: AnthropicChatProviderOptions;
  google: GoogleChatProviderOptions;
};

/**
 * Boss + sub-agent run on Anthropic Sonnet 4.6, degrading to Gemini 2.5 Pro
 * on provider failure via `withFallback`. (Restored 2026-06-07 after the
 * temporary 2026-05-21 → 2026-06-01 spend-cap swap to Gemini 2.5 Pro; the
 * Anthropic-specific provider options inside `AlfredAgent` — cacheControl
 * etc. — are namespaced under `providerOptions.anthropic`, so Gemini ignores
 * them when the fallback serves.)
 */
export function getBossModel(): LanguageModel {
  return withFallback(anthropicModel("claude-sonnet-4-6"), googleModel("gemini-2.5-pro"));
}

export function getSubAgentModel(): LanguageModel {
  return withFallback(anthropicModel("claude-sonnet-4-6"), googleModel("gemini-2.5-pro"));
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
  return withFallback(googleModel("gemini-2.5-flash-lite"), googleModel("gemini-2.5-flash"));
}

/**
 * Transcript compaction is rare, latency-tolerant, and quality-critical.
 * Keep it decoupled from the cheap tier: a bad handoff corrupts the rest
 * of a long boss run, while the incremental cost is negligible.
 */
export const COMPACTOR_MODEL: LanguageModel = anthropicModel("claude-sonnet-4-6");
export const COMPACTOR_FALLBACK_MODEL: LanguageModel = googleModel("gemini-2.5-flash");

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
  return googleModel("gemini-2.5-flash");
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
 * Map an interactive-chat tier to its model (ADR pending; see docs/plans
 * streaming-chat). The chat agent runs on Anthropic by default and escalates
 * to Opus for demanding turns:
 *   - `standard` → Claude Sonnet 4.6 — the default conversational driver.
 *   - `deep`     → Claude Opus 4.8 — escalation for hard, multi-step turns
 *     (and the model the boss-worker harness runs on when chat fans out).
 *
 * Each tier degrades to the corresponding Google tier on Anthropic failure
 * (rate limit, overload, spend cap) so a chat turn never hard-fails on a
 * single provider blip. Sonnet ↔ Gemini 2.5 Pro; Opus ↔ Gemini 2.5 Pro.
 *
 * Restored to the intended Anthropic mapping 2026-06-07 (mirrors
 * `getBossModel`) after the 2026-05-21 spend-cap swap to Google, with the
 * per-tier Google degradation (Sonnet ↔ 2.5 Pro, Opus ↔ 2.5 Pro) wired via
 * `withFallback` so a provider blip degrades instead of hard-failing the turn.
 */
export function getChatModel(tier: ChatModelTier = "standard"): LanguageModel {
  return tier === "deep"
    ? withFallback(anthropicModel("claude-opus-4-8"), googleModel("gemini-2.5-pro"))
    : withFallback(anthropicModel("claude-sonnet-4-6"), googleModel("gemini-2.5-pro"));
}

/**
 * Provider options that ask the chat model to emit its reasoning, so the
 * stream carries `reasoning-delta` parts the chat UI renders as a "Thinking…"
 * accordion. Namespaced per provider — the SDK passes only the block matching
 * the active model and ignores the rest, so this stays correct across the
 * Gemini⇆Anthropic swap in `getChatModel`.
 *
 *   - Gemini 2.5: `thinkingConfig.includeThoughts` surfaces the thought summary
 *     (not the raw chain); `thinkingBudget: -1` lets the model size its own
 *     thinking. Flash thinks by default, so this only toggles *visibility*.
 *   - Anthropic 4.6/4.8: **adaptive** thinking — the model sizes its own
 *     reasoning, capped by `effort`. The legacy `{ type: "enabled",
 *     budgetTokens }` API 400s on Opus 4.8 ("not supported for this model; use
 *     thinking.type.adaptive + output_config.effort"), and because
 *     `withFallback` treats a 400 as any-error → switch, every `deep` turn
 *     silently fell through to Gemini 2.5 Pro (#224). `display: "summarized"`
 *     keeps the thought summary streaming to the accordion. Effort tracks the
 *     tier: `deep` escalates to deliberate reasoning, `standard` stays light
 *     for a fast interactive first token.
 */
export function getChatProviderOptions(tier: ChatModelTier = "standard"): ChatProviderOptions {
  return {
    google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    anthropic: {
      thinking: { type: "adaptive", display: "summarized" },
      effort: tier === "deep" ? "high" : "low",
    },
  };
}

/**
 * Wrap a primary model so a failed call degrades to `fallback` (warden's
 * `createRetryable` pattern — memory `feedback_ai_retry_preference`; the
 * earlier V2/V3 spec-mismatch blocker cleared with `@ai-sdk/*@3.0.x`, which
 * emit `LanguageModelV3`).
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
 *
 * Streaming caveat: fallback only covers errors raised before the stream
 * starts; a provider dying mid-stream after tokens flowed is not replayable.
 *
 * Attribution: the returned model proxies `provider`/`modelId` to whichever
 * model is *currently* serving, and the metering layer records the served
 * model from the response (`served` in `MeteredResult`), so `api_call_log`
 * stays correct when the fallback fires.
 */
export function withFallback(primary: LanguageModelV3, fallback: LanguageModelV3): LanguageModel {
  // True for any error worth degrading to the fallback; false for a
  // non-retryable client bug we want to surface. Built with the raw `error`
  // helper (not `.not()`) so it is inherently error-only — `.not()` of an error
  // condition also matches *successful* results, which the retry loop consults.
  const shouldSwitch = error((e) => {
    if (APICallError.isInstance(e) && e.statusCode !== undefined) {
      const code = e.statusCode;
      const isClientBug = code >= 400 && code < 500 && code !== 408 && code !== 429;
      if (isClientBug) return false;
    }
    return true;
  });
  return createRetryable({
    model: primary,
    retries: [
      error.isRetryable(true).or(timeout()).retry({ delay: 1_000, maxAttempts: 2 }),
      shouldSwitch.switch({ model: fallback }),
    ],
  });
}
