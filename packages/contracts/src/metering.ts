import { enumGuard } from "./guards";

/** Values of `api_call_log.kind` (ADR-0015). `briefing` keeps briefing spend apart (ADR-0041). */
export const ATTRIBUTION_KINDS = [
  "llm",
  "embedding",
  "web_search",
  "transcription",
  "tool_api",
  "briefing",
] as const;

export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];

export const isAttributionKind = enumGuard(ATTRIBUTION_KINDS);
