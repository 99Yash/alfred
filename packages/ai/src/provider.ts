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
