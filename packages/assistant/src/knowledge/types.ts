import { jsonRecordSchema, memorySourceSchema } from "@alfred/contracts";
import { z } from "zod";

/**
 * Where a fact / preference / chunk came from. Provenance discipline
 * (ADR-0019): every inferred row cites a specific origin so the user
 * can ask "why do you think that?" and get a non-hallucinated answer.
 *
 * `parseMemorySourceOrDefault` is the shared parse door — it lives in
 * `@alfred/contracts` beside `memorySourceSchema`; re-exported here so
 * `facts.ts` / `chunks.ts` keep importing it from `./types`.
 */
export type { MemorySource } from "@alfred/contracts";

export { parseMemorySourceOrDefault } from "@alfred/contracts";

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

/**
 * Kinds that record Alfred's own operational bookkeeping, never something
 * Alfred knows about the user. An `extraction_run` chunk is run telemetry
 * ("processed 20 documents; proposed 0 facts"), so it must never render as
 * user memory. Kept as a set so the classification reads as membership.
 */
const OPERATIONAL_MEMORY_CHUNK_KINDS: ReadonlySet<MemoryChunkKind> = new Set(["extraction_run"]);

/**
 * The memory chunk kinds a user-facing read may surface. Derived by subtraction
 * so a newly added kind is included by default rather than silently hidden; a
 * new operational kind is one line in the set above.
 */
export const USER_FACING_MEMORY_CHUNK_KINDS: readonly MemoryChunkKind[] = MEMORY_CHUNK_KINDS.filter(
  (kind) => !OPERATIONAL_MEMORY_CHUNK_KINDS.has(kind),
);

export { jsonRecordSchema, memorySourceSchema };
