/**
 * Where a fact / preference / chunk came from. Provenance discipline
 * (ADR-0019): every inferred row cites a specific origin so the user
 * can ask "why do you think that?" and get a non-hallucinated answer.
 */
export { memorySourceSchema } from "@alfred/sync";
export type { MemorySource } from "@alfred/sync";

export const FACT_STATUSES = ["proposed", "confirmed", "rejected", "edited", "superseded"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/**
 * Confidence ≥ this auto-confirms a proposal; < this stays `proposed`
 * and waits for the user (ADR-0019). Tunable post-launch — start strict.
 */
export const AUTO_CONFIRM_THRESHOLD = 0.85;

export const STYLE_CHANNELS = [
  "gmail",
  "imessage",
  "slack",
  "doc",
  "code_review",
  "twitter",
  "generic",
] as const;
export type StyleChannel = (typeof STYLE_CHANNELS)[number];

export const STYLE_AUDIENCE_BUCKETS = [
  "family",
  "friend",
  "peer",
  "manager",
  "customer",
  "vendor",
  "public",
  "generic",
] as const;
export type StyleAudienceBucket = (typeof STYLE_AUDIENCE_BUCKETS)[number];

export const ENTITY_KINDS = [
  "person",
  "organization",
  "project",
  "product",
  "location",
  "other",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const MEMORY_CHUNK_KINDS = [
  "thread_summary",
  "extraction_run",
  "cold_start_research",
  "manual",
] as const;
export type MemoryChunkKind = (typeof MEMORY_CHUNK_KINDS)[number];
