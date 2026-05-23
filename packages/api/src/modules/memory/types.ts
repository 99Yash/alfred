import { jsonRecordSchema, memorySourceSchema } from "@alfred/sync";
import { z } from "zod";
import type { MemorySource } from "@alfred/sync";

/**
 * Where a fact / preference / chunk came from. Provenance discipline
 * (ADR-0019): every inferred row cites a specific origin so the user
 * can ask "why do you think that?" and get a non-hallucinated answer.
 */
export type { MemorySource } from "@alfred/sync";

export function parseMemorySourceOrDefault(
  value: unknown,
  fallback: MemorySource,
  context: string,
): MemorySource {
  const parsed = memorySourceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(
    `[memory] using fallback source for ${context}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
  );
  return fallback;
}

export const FACT_STATUSES = ["proposed", "confirmed", "rejected", "edited", "superseded"] as const;
export const factStatusSchema = z.enum(FACT_STATUSES);
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
export const styleChannelSchema = z.enum(STYLE_CHANNELS);
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
export const styleAudienceBucketSchema = z.enum(STYLE_AUDIENCE_BUCKETS);
export type StyleAudienceBucket = (typeof STYLE_AUDIENCE_BUCKETS)[number];

export const ENTITY_KINDS = [
  "person",
  "organization",
  "project",
  "product",
  "location",
  "other",
] as const;
export const entityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const MEMORY_CHUNK_KINDS = [
  "thread_summary",
  "extraction_run",
  "cold_start_research",
  "manual",
] as const;
export const memoryChunkKindSchema = z.enum(MEMORY_CHUNK_KINDS);
export type MemoryChunkKind = (typeof MEMORY_CHUNK_KINDS)[number];

export { jsonRecordSchema, memorySourceSchema };
