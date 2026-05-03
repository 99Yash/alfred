import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { perplexity } from "@ai-sdk/perplexity";
import type { LanguageModel } from "ai";

export function getBossModel(): LanguageModel {
  return anthropic("claude-sonnet-4-6");
}

export function getSubAgentModel(): LanguageModel {
  return anthropic("claude-sonnet-4-6");
}

export function getCheapModel(): LanguageModel {
  return google("gemini-2.5-flash");
}

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
