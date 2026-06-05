import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { perplexity } from "@ai-sdk/perplexity";
import type { LanguageModel } from "ai";

/**
 * Temporary provider swap (2026-05-21): boss + sub-agent routed through
 * Google Gemini 2.5 Pro instead of Anthropic Sonnet 4.6 while the
 * Anthropic workspace spend cap is in effect (resets 2026-06-01). Swap
 * back by returning `anthropic("claude-sonnet-4-6")` here once the cap
 * clears.
 *
 * Behavioural notes for the swap window:
 *   - The briefing agent (and any other AlfredAgent consumers) doesn't
 *     send Anthropic-specific cache annotations through this path, so
 *     no rework needed at the call site.
 *   - Anthropic-specific provider options inside `AlfredAgent`
 *     (cacheControl etc.) are namespaced under `providerOptions.anthropic`;
 *     Gemini silently ignores them.
 */
export function getBossModel(): LanguageModel {
  return google("gemini-2.5-pro");
}

export function getSubAgentModel(): LanguageModel {
  return google("gemini-2.5-pro");
}

export function getCheapModel(): LanguageModel {
  // Flash-Lite is Google's lowest-latency tier — typical p50 is well under
  // a second for the short JSON outputs triage/extraction produce. Switched
  // from `gemini-2.5-flash` after the user flagged label-write lag on a
  // single inbound email; the larger Flash model was the bottleneck, not
  // the pipeline.
  return google("gemini-2.5-flash-lite");
}

/**
 * Transcript compaction is rare, latency-tolerant, and quality-critical.
 * Keep it decoupled from the cheap tier: a bad handoff corrupts the rest
 * of a long boss run, while the incremental cost is negligible.
 */
export const COMPACTOR_MODEL: LanguageModel = anthropic("claude-sonnet-4-6");
export const COMPACTOR_FALLBACK_MODEL: LanguageModel = google("gemini-2.5-flash");

/**
 * Live web-search model for short, agent-driven lookups. Per ADR-0022:
 * Perplexity Sonar Pro for the synthesis-shaped agent tool path.
 *
 * Caller must route through `meteredGenerateText` with
 * `attribution.kind = 'web_search'` so `api_call_log` rollups bucket the
 * spend correctly.
 */
export function getWebSearchModel(): LanguageModel {
  return perplexity("sonar-pro");
}

/**
 * Multi-step research model for cold-start signup research (ADR-0011 +
 * ADR-0022). Sonar Deep Research takes 30–90s per call and is only
 * appropriate for async workflows; never call from a request handler.
 *
 * Caller must route through `meteredGenerateText` with
 * `attribution.kind = 'web_search'`.
 */
export function getResearchModel(): LanguageModel {
  return perplexity("sonar-deep-research");
}

/**
 * Interactive-chat model tiers (ADR pending; see docs/plans streaming-chat).
 *
 * The chat agent runs on Anthropic by default and escalates to Opus for
 * demanding turns:
 *   - `standard` → Claude Sonnet 4.6 — the default conversational driver.
 *   - `deep`     → Claude Opus 4.8 — escalation for hard, multi-step turns
 *     (and the model the boss-worker harness runs on when chat fans out).
 *
 * Each tier degrades to the corresponding Google tier on Anthropic failure
 * (rate limit, overload, spend cap) so a chat turn never hard-fails on a
 * single provider blip. Sonnet ↔ Gemini 2.5 Pro; Opus ↔ Gemini 2.5 Pro.
 */
export type ChatModelTier = "standard" | "deep";

/**
 * Spend-cap swap (mirrors `getBossModel`, 2026-05-21): while the Anthropic
 * workspace spend cap is in effect, chat runs on Google. Gemini 2.5 Flash for
 * `standard` (low-latency, the right feel for interactive chat — 2.5 Pro runs
 * minutes/turn) and 2.5 Pro for `deep` escalation.
 *
 * Intended mapping once the cap clears (swap back by returning the
 * `anthropic(...)` line): `standard → claude-sonnet-4-6`,
 * `deep → claude-opus-4-8`. The Anthropic path also wants `withFallback(...,
 * google(...))` once that wrapper is unblocked (see below).
 */
export function getChatModel(tier: ChatModelTier = "standard"): LanguageModel {
  // return tier === "deep" ? anthropic("claude-opus-4-8") : anthropic("claude-sonnet-4-6");
  return tier === "deep" ? google("gemini-2.5-pro") : google("gemini-2.5-flash");
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
 *   - Anthropic (when the cap clears): extended thinking with a modest budget —
 *     interactive chat wants a fast first token, not a deep deliberation.
 */
export function getChatProviderOptions(): Record<string, Record<string, unknown>> {
  return {
    google: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
    anthropic: { thinking: { type: "enabled", budgetTokens: 2_048 } },
  };
}

/**
 * Wrap a primary model so a failed call degrades to `fallback`.
 *
 * TODO(fallback): not yet wired. The intended implementation is the AI SDK's
 * `wrapLanguageModel` middleware (`wrapGenerate`/`wrapStream` → try primary,
 * catch, replay against the fallback) — warden's `createRetryable` pattern,
 * see memory `feedback_ai_retry_preference`. It's blocked today by a spec
 * mismatch: `@ai-sdk/anthropic@3` / `@ai-sdk/google` emit `LanguageModelV2`
 * models while `wrapLanguageModel` is typed for `v3`, so the wrapper doesn't
 * type-check. Revisit when the provider packages move to v3 (or adopt the
 * `ai-retry` dependency). Until then this returns the primary unchanged —
 * `getChatModel` stays the stable seam, so hardening later touches no callers.
 * Per memory, provider fallback is resilience polish, not a launch blocker.
 */
export function withFallback(primary: LanguageModel, _fallback: LanguageModel): LanguageModel {
  return primary;
}
