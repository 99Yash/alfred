import { memorySourceSchema, type MemorySource } from "@alfred/contracts";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { createId, lifecycle_dates, vectorColumn } from "../helpers";
import { user } from "./auth";
import { documents } from "./documents";

function memorySourceShapeCheck(source: AnyPgColumn) {
  return sql`jsonb_typeof(${source}) = 'object'
    AND ${source} ? 'kind'
    AND ${source}->>'kind' IN ('document', 'chunk', 'tool_call', 'cold_start', 'user', 'agent')
    AND (${source}->'id' IS NULL OR jsonb_typeof(${source}->'id') = 'string')
    AND (${source}->'meta' IS NULL OR jsonb_typeof(${source}->'meta') = 'object')`;
}

// Memory tables (ADRs 0012, 0013, 0019). Status and kind columns are `text`,
// not pg enums, because enum migrations are awkward. Zod validates them.

// ---------------------------------------------------------------------------
// user_facts
// ---------------------------------------------------------------------------

/**
 * Status (ADR-0019): proposed, confirmed, rejected, edited, superseded.
 * A user edit marks the old row `edited`; a system replacement marks it `superseded`.
 * The current value is the `confirmed` row whose `valid_until` is null or in the future.
 */
export const userFacts = pgTable(
  "user_facts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("fact")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** For example `manager`, `relationship:alice@oliv.ai`, `pref:tone`. */
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    /** 0 to 1. At 0.85 or more, the fact auto-confirms (ADR-0019). */
    confidence: real("confidence").notNull(),
    status: text("status").notNull().default("proposed"),
    source: jsonb("source")
      .$type<MemorySource>()
      .notNull()
      .default(sql`'{"kind":"agent"}'::jsonb`),
    /** When the fact became true (ADR-0012). A successor row sets `validUntil`. */
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** The row this one replaces. */
    supersedesId: text("supersedes_id"),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    index("user_facts_key_idx").on(t.userId, t.key, t.status),
    index("user_facts_status_idx").on(t.userId, t.status, t.updatedAt),
    index("user_facts_supersedes_idx").on(t.supersedesId),
    check("user_facts_source_shape", memorySourceShapeCheck(t.source)),
  ],
);

export const userFactInsertSchema = createInsertSchema(userFacts, {
  source: memorySourceSchema.optional(),
});

// ---------------------------------------------------------------------------
// user_preferences
// ---------------------------------------------------------------------------

/**
 * One row per (user, key), overwritten in place. Always confirmed, no supersession.
 * `timezone` is the IANA zone; `briefing.timezone` is a legacy fallback (#229).
 * `feature.*` keys are background-agent toggles. An unset key uses
 * `FEATURE_FLAG_DEFAULTS` from `@alfred/contracts`.
 */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("pref")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    source: jsonb("source")
      .$type<MemorySource>()
      .notNull()
      .default(sql`'{"kind":"user"}'::jsonb`),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("user_preferences_unique_idx").on(t.userId, t.key),
    check("user_preferences_source_shape", memorySourceShapeCheck(t.source)),
  ],
);

export const userPreferenceInsertSchema = createInsertSchema(userPreferences, {
  source: memorySourceSchema.optional(),
});

// ---------------------------------------------------------------------------
// style_profiles
// ---------------------------------------------------------------------------

/**
 * Drafting style per channel, audience bucket, and optional recipient (ADR-0013).
 * Lookup order: recipient, then bucket, then channel.
 */
export const styleProfiles = pgTable(
  "style_profiles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("sty")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    audienceBucket: text("audience_bucket").notNull(),
    /** Null for a bucket-level profile. */
    recipientId: text("recipient_id"),
    profileDoc: text("profile_doc").notNull(),
    examples: jsonb("examples")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Document ids the profile was built from. */
    sourceMsgIds: jsonb("source_msg_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    generatedFromCount: integer("generated_from_count").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    status: text("status").notNull().default("draft"),
    supersededById: text("superseded_by_id"),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // NULLs are distinct here on purpose: one bucket row plus many recipient rows.
    uniqueIndex("style_profiles_unique_idx").on(
      t.userId,
      t.channel,
      t.audienceBucket,
      t.recipientId,
    ),
    index("style_profiles_lookup_idx").on(t.userId, t.channel, t.status),
  ],
);

export const styleProfileInsertSchema = createInsertSchema(styleProfiles);

// ---------------------------------------------------------------------------
// entities + entity_relations
// ---------------------------------------------------------------------------

/** Small in-DB graph (ADR-0012). Recursive CTEs do the traversal. */
export const entities = pgTable(
  "entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ent")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    canonicalName: text("canonical_name").notNull(),
    aliases: jsonb("aliases")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  // Also serves prefix lookups on (user_id) and (user_id, kind).
  (t) => [uniqueIndex("entities_canonical_idx").on(t.userId, t.kind, t.canonicalName)],
);

export const entityInsertSchema = createInsertSchema(entities);

export const entityRelations = pgTable(
  "entity_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("rel")),
    /** Denormalized so traversal can filter without joining `entities`. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fromEntityId: text("from_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: text("to_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_relations_unique_idx").on(
      t.userId,
      t.fromEntityId,
      t.toEntityId,
      t.relation,
    ),
    index("entity_relations_from_idx").on(t.userId, t.fromEntityId),
    index("entity_relations_to_idx").on(t.userId, t.toEntityId),
  ],
);

export const entityRelationInsertSchema = createInsertSchema(entityRelations);

// ---------------------------------------------------------------------------
// memory_chunks
// ---------------------------------------------------------------------------

/**
 * Vector recall over summaries Alfred writes as it learns (ADR-0012).
 * Not provider data; that is `chunks`. Rows are written first and embedded later.
 */
export const memoryChunks = pgTable(
  "memory_chunks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("mem")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    embedding: vectorColumn("embedding", 1024),
    /** sha256 of `content`. */
    contentHash: text("content_hash").notNull(),
    source: jsonb("source")
      .$type<MemorySource>()
      .notNull()
      .default(sql`'{"kind":"agent"}'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Embed retry columns, same as `documents`. See `buildEmbedFailureSet`.
    embedAttempts: integer("embed_attempts").notNull().default(0),
    embedFirstFailedAt: timestamp("embed_first_failed_at", { withTimezone: true }),
    /** Dead-letter mark; the sweep skips the row. To retry in place, null this and `embedFirstFailedAt`. */
    embedFailedAt: timestamp("embed_failed_at", { withTimezone: true }),
    lastEmbedError: text("last_embed_error"),
    ...lifecycle_dates,
  },
  (t) => [
    index("memory_chunks_user_kind_idx").on(t.userId, t.kind, t.createdAt),
    uniqueIndex("memory_chunks_hash_idx").on(t.userId, t.kind, t.contentHash),
    index("memory_chunks_embed_sweep_idx")
      .on(t.id)
      .where(sql`${t.embedding} IS NULL AND ${t.embedFailedAt} IS NULL`),
    check("memory_chunks_source_shape", memorySourceShapeCheck(t.source)),
  ],
);

export const memoryChunkInsertSchema = createInsertSchema(memoryChunks, {
  source: memorySourceSchema.optional(),
});

// ---------------------------------------------------------------------------
// memory_extraction_status
// ---------------------------------------------------------------------------

/** Marks a document as extracted, so the extraction workflow does not pay to read it again. */
export const memoryExtractionStatus = pgTable(
  "memory_extraction_status",
  {
    documentId: text("document_id")
      .primaryKey()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastExtractedAt: timestamp("last_extracted_at", { withTimezone: true }).defaultNow().notNull(),
    /** `agent_runs.id`. */
    lastRunId: text("last_run_id"),
    proposedCount: integer("proposed_count").notNull().default(0),
    /**
     * Set when the headers are folded into the team graph (ADR-0059 P4a).
     * Separate from `lastExtractedAt`. Set in the same transaction as the fold.
     */
    capturedIntoGraphAt: timestamp("captured_into_graph_at", { withTimezone: true }),
  },
  (t) => [index("memory_extraction_status_user_idx").on(t.userId, t.lastExtractedAt)],
);

// ---------------------------------------------------------------------------
// rejected_inferences
// ---------------------------------------------------------------------------

/** Facts the user rejected, so extraction does not propose them again (ADR-0019). */
export const rejectedInferences = pgTable(
  "rejected_inferences",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("rinf")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** `valueSignature(value)`: a sha256 hash. The value itself is not stored. */
    valueSignature: text("value_signature").notNull(),
    proposedFactId: text("proposed_fact_id"),
    reason: jsonb("reason"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [uniqueIndex("rejected_inferences_signature_idx").on(t.userId, t.key, t.valueSignature)],
);

export type UserFact = typeof userFacts.$inferSelect;

export type NewUserFact = typeof userFacts.$inferInsert;

export type UserPreference = typeof userPreferences.$inferSelect;

export type NewUserPreference = typeof userPreferences.$inferInsert;

export type StyleProfile = typeof styleProfiles.$inferSelect;

export type NewStyleProfile = typeof styleProfiles.$inferInsert;

export type Entity = typeof entities.$inferSelect;

export type NewEntity = typeof entities.$inferInsert;

export type EntityRelation = typeof entityRelations.$inferSelect;

export type NewEntityRelation = typeof entityRelations.$inferInsert;

export type MemoryChunk = typeof memoryChunks.$inferSelect;

export type NewMemoryChunk = typeof memoryChunks.$inferInsert;

export type MemoryExtractionStatus = typeof memoryExtractionStatus.$inferSelect;

export type RejectedInference = typeof rejectedInferences.$inferSelect;
