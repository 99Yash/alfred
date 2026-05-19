import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates, vectorColumn } from "../helpers";
import { user } from "./auth";
import { documents } from "./documents";

/**
 * Memory primitives (ADRs 0012, 0013, 0019).
 *
 * Five tables form the memory layer:
 *
 *   user_facts          structured key/value with provenance, confidence, supersession
 *   user_preferences    one row per (user, key) — tone, response length, tool defaults
 *   style_profiles      per (channel × audience × recipient) drafting profile
 *   entities            lightweight in-DB graph: people, orgs, projects
 *   entity_relations    edges over entities ('manager_of', 'works_at', …)
 *   memory_chunks       pgvector recall over freeform conversation summaries
 *   rejected_inferences pattern signatures of user-rejected facts (re-extraction guard)
 *
 * All `status`, `kind`, `channel`, `audience_bucket` columns are `text`
 * rather than pg enums — Drizzle migrations on enum change are awkward
 * and we already validate at the app boundary with zod.
 */

// ---------------------------------------------------------------------------
// user_facts
// ---------------------------------------------------------------------------

/**
 * Status lifecycle (ADR-0019):
 *
 *   proposed   newly inferred; awaiting user accept (or auto-confirm if
 *              `confidence > 0.85` per the correction-loop UX).
 *   confirmed  explicitly or auto-accepted; the active row for `key`.
 *   rejected   user rejected; row stays for audit, plus the (key, value)
 *              signature lands in `rejected_inferences` so re-extraction
 *              doesn't re-propose it.
 *   edited     user-edited an existing row; the OLD row gets `edited`
 *              status, the NEW row is `confirmed` and points back via
 *              `supersedes_id`. Distinct from `superseded` so the UI can
 *              tell user-edits apart from system replacements.
 *   superseded system replaced the row (re-extraction with higher confidence,
 *              conflict resolution); successor links back via `supersedes_id`.
 *
 * Read-side: "current value of `manager`" = the row where
 * `(user_id, key) = (…, 'manager')` AND `status = 'confirmed'` AND
 * (`valid_until IS NULL OR valid_until > now()`). Indexed below.
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
    /** Stable key — `manager`, `company`, `birthday`, `relationship:alice@oliv.ai`, `pref:tone`. */
    key: text("key").notNull(),
    /** Free-form value. Strings, objects, lists — extractor decides per key. */
    value: jsonb("value").notNull(),
    /** [0, 1] inferred-confidence. ≥0.85 auto-confirms (ADR-0019). */
    confidence: real("confidence").notNull(),
    /** proposed | confirmed | rejected | edited | superseded — see file header. */
    status: text("status").notNull().default("proposed"),
    /** Provenance: { kind: 'document'|'chunk'|'tool_call'|'cold_start'|'user', id?: string }. */
    source: jsonb("source")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Temporal validity window (ADR-0012). `valid_from` is when the fact
     * became true (extractor's best guess at the source's authoring time),
     * `valid_until` flips when a successor row narrows the window.
     */
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** Self-reference: this row replaces `supersedes_id`. */
    supersedesId: text("supersedes_id"),
    /** Replicache row version (m8c uses this once facts sync to clients). */
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    index("user_facts_key_idx").on(t.userId, t.key, t.status),
    index("user_facts_status_idx").on(t.userId, t.status, t.updatedAt),
    index("user_facts_supersedes_idx").on(t.supersedesId),
  ],
);

// ---------------------------------------------------------------------------
// user_preferences
// ---------------------------------------------------------------------------

/**
 * One row per (user, key). Kept separate from `user_facts` because
 * preferences (a) are always confirmed (the user sets them directly),
 * (b) have no supersession chain — overwriting in place is fine,
 * (c) often need a single source-of-truth for the agent runtime to read.
 *
 * Examples: `tone`, `response_length`, `gmail.include_drafts`,
 * `briefing.timezone`, `briefing.delivery_hour`.
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
    /** Optional provenance — usually `{ kind: 'user' }`; agents can suggest a pref via `{ kind: 'agent' }`. */
    source: jsonb("source")
      .notNull()
      .default(sql`'{}'::jsonb`),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [uniqueIndex("user_preferences_unique_idx").on(t.userId, t.key)],
);

// ---------------------------------------------------------------------------
// style_profiles
// ---------------------------------------------------------------------------

/**
 * Per (channel × audience_bucket × recipient_id) drafting profile (ADR-0013).
 *
 * `recipient_id` NULL = bucket-level profile (e.g. "gmail-to-managers").
 * Lookup precedence at draft-time: recipient → audience_bucket → channel-generic.
 *
 * `profile_doc` is an LLM-readable style guide; `examples` is 3-5 samples
 * cited from `source_msg_ids`. Both go in the prompt — doc as instructions,
 * examples as evidence (ADR-0013 rationale).
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
    /** gmail | imessage | slack | doc | code_review | twitter | generic. */
    channel: text("channel").notNull(),
    /** family | friend | peer | manager | customer | vendor | public | generic. */
    audienceBucket: text("audience_bucket").notNull(),
    /** Specific person identifier (email, slack user id, …). NULL for bucket-level. */
    recipientId: text("recipient_id"),
    profileDoc: text("profile_doc").notNull(),
    /** [{ subject, body, sentAt }] or similar — channel-shaped. */
    examples: jsonb("examples")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Provenance: array of document ids the profile was distilled from. */
    sourceMsgIds: jsonb("source_msg_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /** How many source messages went into this profile. Drives `regenerate_needed` heuristics. */
    generatedFromCount: integer("generated_from_count").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    /** draft | active | superseded. */
    status: text("status").notNull().default("draft"),
    supersededById: text("superseded_by_id"),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    // recipient_id is nullable; uniqueness includes it so bucket-level (NULL)
    // and recipient-level rows coexist. Postgres treats NULLs as distinct in
    // a unique index by default — `NULLS NOT DISTINCT` would be tighter but
    // we genuinely want one bucket-level row + many recipient-level rows.
    uniqueIndex("style_profiles_unique_idx").on(
      t.userId,
      t.channel,
      t.audienceBucket,
      t.recipientId,
    ),
    index("style_profiles_lookup_idx").on(t.userId, t.channel, t.status),
  ],
);

// ---------------------------------------------------------------------------
// entities + entity_relations
// ---------------------------------------------------------------------------

/**
 * Lightweight in-DB graph (ADR-0012). Recursive CTEs handle multi-hop
 * traversal at the scale alfred deals with (≪ 10K entities).
 */
export const entities = pgTable(
  "entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ent")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** person | organization | project | product | location | other. */
    kind: text("kind").notNull(),
    canonicalName: text("canonical_name").notNull(),
    /** Alternate names, email aliases, slack handles. */
    aliases: jsonb("aliases")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Free-form bag — title, domain, headshot url, … */
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  // The unique index on (user_id, kind, canonical_name) doubles as the
  // lookup index — Postgres uses it for prefix queries on (user_id) and
  // (user_id, kind) just like a btree.
  (t) => [uniqueIndex("entities_canonical_idx").on(t.userId, t.kind, t.canonicalName)],
);

export const entityRelations = pgTable(
  "entity_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("rel")),
    /** Denormalized so traversal queries can filter without joining `entities` twice. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fromEntityId: text("from_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: text("to_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** manager_of | reports_to | works_at | colleague_of | invested_in | … */
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

// ---------------------------------------------------------------------------
// memory_chunks
// ---------------------------------------------------------------------------

/**
 * pgvector recall over freeform memory blobs — conversation summaries,
 * cold-start research notes, extraction-run artifacts (ADR-0012).
 *
 * Distinct from `chunks` (which slices ingested integration content).
 * `memory_chunks` is alfred's *interpretation* layer — distilled summaries
 * the agent writes back as it learns, not raw provider data.
 *
 * `embedding` is nullable on the same write-then-embed pattern as `chunks`:
 * write rows synchronously, embed in a background sweep (m8b).
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
    /** thread_summary | extraction_run | cold_start_research | manual. */
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    embedding: vectorColumn("embedding", 1024),
    /** sha256 of `content` — skip re-embed when content hasn't changed. */
    contentHash: text("content_hash").notNull(),
    /** Provenance refs: `{ kind: 'thread_summary', threadId: '…' }`, `{ kind: 'extraction_run', runId: '…' }`. */
    source: jsonb("source")
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    index("memory_chunks_user_kind_idx").on(t.userId, t.kind, t.createdAt),
    uniqueIndex("memory_chunks_hash_idx").on(t.userId, t.kind, t.contentHash),
  ],
);

// ---------------------------------------------------------------------------
// memory_extraction_status
// ---------------------------------------------------------------------------

/**
 * Per-document extraction bookkeeping. The daily extraction workflow
 * skips documents already processed within its sliding window so the
 * cheap-tier model isn't billed to re-read the same email every day.
 *
 * Why a junction table, not a column on `documents`:
 *  - keeps memory bookkeeping out of the ingestion-side schema;
 *  - lets us cascade-delete via document FK without ON UPDATE coupling;
 *  - leaves room to add per-run audit fields (proposed_count, etc.)
 *    without churning `documents`.
 */
export const memoryExtractionStatus = pgTable(
  "memory_extraction_status",
  {
    /** PK = document id. One status row per (document, user) — there's only one user per document anyway. */
    documentId: text("document_id")
      .primaryKey()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastExtractedAt: timestamp("last_extracted_at", { withTimezone: true }).defaultNow().notNull(),
    /** Pointer to the originating `agent_runs.id`. */
    lastRunId: text("last_run_id"),
    /** How many facts the extractor proposed for this doc on the last run. */
    proposedCount: integer("proposed_count").notNull().default(0),
  },
  (t) => [index("memory_extraction_status_user_idx").on(t.userId, t.lastExtractedAt)],
);

// ---------------------------------------------------------------------------
// rejected_inferences
// ---------------------------------------------------------------------------

/**
 * Pattern store for facts the user rejected. The extraction sub-agent
 * consults this before emitting a proposal — "did the user already say
 * no to (key='manager', value='Bob')?" — and skips on hit (ADR-0019).
 *
 * `value_signature` is a stable hash of the rejected value so identical
 * proposals dedup; we don't store the value itself to keep this table
 * small and to avoid baking exact strings into a deny-list.
 */
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
    /** Stable hash (sha256 hex of canonical-JSON value). */
    valueSignature: text("value_signature").notNull(),
    /** Optional pointer back to the originating user_facts row. */
    proposedFactId: text("proposed_fact_id"),
    /** Free-form rejection reason captured from the UI ("wrong person", "no longer true", …). */
    reason: jsonb("reason"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("rejected_inferences_signature_idx").on(t.userId, t.key, t.valueSignature),
    index("rejected_inferences_key_idx").on(t.userId, t.key),
  ],
);
