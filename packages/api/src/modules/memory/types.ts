import { z } from "zod";

/**
 * Where a fact / preference / chunk came from. Provenance discipline
 * (ADR-0019): every inferred row cites a specific origin so the user
 * can ask "why do you think that?" and get a non-hallucinated answer.
 */
export const memorySourceSchema = z.object({
  kind: z.enum([
    /** Pulled from an ingested document (email, slack message, doc). */
    "document",
    /** Pulled from a specific chunk within a document. */
    "chunk",
    /** Output of a tool call (e.g. Gmail profile lookup). */
    "tool_call",
    /** Cold-start research at signup. */
    "cold_start",
    /** User typed it directly (settings page, in-app card, chat correction). */
    "user",
    /** Inferred by an agent run; the run id is the citation. */
    "agent",
  ]),
  /** The originating row id — `doc_xxx`, `chk_xxx`, `run_xxx`, etc. NULL for `user` / unsourced. */
  id: z.string().optional(),
  /** Free-form rider — model name, tool slug, run step id, … */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

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
