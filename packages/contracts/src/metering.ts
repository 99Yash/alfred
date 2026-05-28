/**
 * Discriminator for `api_call_log.kind` rows (ADR-0015, ADR-0041). Lives in
 * `@alfred/contracts` so the web cost-rollup UI can read the union without
 * pulling in `@alfred/ai`'s Node-only dependencies. `@alfred/ai` re-exports
 * `AttributionKind` as `CallKind` for source compatibility with existing
 * callers; new code should use the contracts-side name.
 *
 * `'briefing'` was added per ADR-0041 §"Costing" so daily-briefing compose
 * spend buckets apart from per-agent-run LLM cost.
 */

export const ATTRIBUTION_KINDS = [
  "llm",
  "embedding",
  "web_search",
  "transcription",
  "tool_api",
  "briefing",
] as const;

export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

export function isAttributionKind(value: unknown): value is AttributionKind {
  return typeof value === "string" && (ATTRIBUTION_KINDS as readonly string[]).includes(value);
}
