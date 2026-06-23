import type {
  EntityEdgeType,
  EntityNodeKind,
  IdentityKind,
  ObservationKind,
  ObservationSource,
  ProjectionRunStatus,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * Multi-source user-model substrate (ADR-0067, #218).
 *
 * An append-only `observations` log is the system of record; entities,
 * cross-source identities, relations, the social graph, significance, and facts
 * are deterministic, replayable PROJECTIONS over it. Two contracts (D2/D13/D16):
 *
 *   STABLE  layer — `entity_nodes`, `entity_identities`. These carry the
 *           foreign-key identity the rest of Alfred references; their ids are
 *           content-addressed (see `computeStableEntityId`) and NEVER
 *           projection-versioned. Merges leave a forwarding pointer
 *           (`supersedes_entity_id`); reads resolve through it.
 *   VERSIONED layer — `entity_profiles`, `entity_edges`, `entity_co_occurrence`.
 *           Recomputable read models keyed by `projection_version`. Change a
 *           weight / cutoff / classifier and replay into a new version, then
 *           flip the active pointer — without re-minting stable ids.
 *
 * These tables COEXIST with the legacy aggregate graph (`entities`,
 * `entity_relations` in `memory.ts`) through the shadow phase (D10); the legacy
 * tables are dropped only at cutover. Hence the distinct names.
 *
 * `source` / `kind` / `relation_type` columns are `text` (validated at the app
 * boundary against the `@alfred/contracts` registries), not pg enums — same
 * rationale as the rest of the schema. The new substrate-specific behavior
 * (reducers, the fold, active-version views) lands in P1+; P0 is shape only.
 */

/** Typed identity reference stored in observation subject/object + entity canonical identity. */
type IdentityRef = { kind: IdentityKind; value: string };

// ---------------------------------------------------------------------------
// observations — append-only system of record (D1, D4)
// ---------------------------------------------------------------------------

export const observations = pgTable(
  "observations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("obs")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Provider or `user`/`alfred_chat` — see OBSERVATION_SOURCES. */
    source: text("source").$type<ObservationSource>().notNull(),
    /** Relationship-evidence kind — see OBSERVATION_KINDS (D15). */
    kind: text("kind").$type<ObservationKind>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Stable event identity, e.g. `gmail:<message_id>`, `github:pr:<repo>:<number>` (D4). */
    familyKey: text("family_key").notNull(),
    /** Hash over relationship-significant fields only (participants, start, …). */
    evidenceHash: text("evidence_hash").notNull(),
    /** `family_key:evidence_hash` — same evidence dedups, changed evidence appends + supersedes. */
    dedupKey: text("dedup_key").notNull(),
    subjectIdentity: jsonb("subject_identity").$type<IdentityRef>().notNull(),
    objectIdentity: jsonb("object_identity").$type<IdentityRef | null>(),
    /** Full participant set + recipientCount + list_id — the fold derives pairwise edges. */
    participants: jsonb("participants")
      .notNull()
      .default(sql`'[]'::jsonb`),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    schemaVersion: integer("schema_version").notNull().default(1),
    reducerVersion: integer("reducer_version").notNull().default(1),
    /** Prior active family member this row supersedes (changed evidence, D4). */
    supersedesObservationId: text("supersedes_observation_id"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("observations_dedup_idx").on(t.userId, t.dedupKey),
    index("observations_source_time_idx").on(t.userId, t.source, t.occurredAt),
    index("observations_family_idx").on(t.userId, t.familyKey),
  ],
);

// ---------------------------------------------------------------------------
// entity_nodes — STABLE node (D2). Content-addressed id, never version-partitioned.
// ---------------------------------------------------------------------------

export const entityNodes = pgTable(
  "entity_nodes",
  {
    /** Content-addressed from the seeding hard identity (`computeStableEntityId`). No random default. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The anchor identity this id was seeded from. */
    canonicalIdentity: jsonb("canonical_identity").$type<IdentityRef>().notNull(),
    /** Set on the loser of a merge → points at the surviving (best-anchor) node. Reads resolve through this. */
    supersedesEntityId: text("supersedes_entity_id"),
    /** Earliest observation timestamp for this node — anchor tie-break (D2). */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    index("entity_nodes_user_idx").on(t.userId),
    index("entity_nodes_supersedes_idx").on(t.supersedesEntityId),
  ],
);

// ---------------------------------------------------------------------------
// entity_identities — STABLE typed identity keys (D2). Replaces `aliases` jsonb.
// ---------------------------------------------------------------------------

export const entityIdentities = pgTable(
  "entity_identities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("eid")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entityNodes.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IdentityKind>().notNull(),
    /** Normalized identity value (lowercased email, canonical login, …). */
    value: text("value").notNull(),
    confidence: real("confidence").notNull().default(1),
    source: text("source").$type<ObservationSource>().notNull(),
    /** True for a hard-verified identity (Workspace directory, confirmed bridge). Tie-break, not a rank gate. */
    verified: boolean("verified").notNull().default(false),
    /** True when set by an explicit user pin / correction — anchor tier 1 (D2). */
    userPinned: boolean("user_pinned").notNull().default(false),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    supersedesId: text("supersedes_id"),
    /** Provenance: originating observation ids. */
    provenance: jsonb("provenance")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_identities_unique_idx").on(t.userId, t.kind, t.value),
    index("entity_identities_entity_idx").on(t.userId, t.entityId),
  ],
);

// ---------------------------------------------------------------------------
// entity_profiles — VERSIONED display/kind/significance components (D6, D7, D13)
// ---------------------------------------------------------------------------

export const entityProfiles = pgTable(
  "entity_profiles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("eprof")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectionVersion: integer("projection_version").notNull(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entityNodes.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /** Kind lives here (versioned) — a better classifier can change it without re-minting the id (D7). */
    kind: text("kind").$type<EntityNodeKind>().notNull(),
    /** Time-invariant significance components only; final score = base(components) * recency(asOf) at read time (D6). */
    significanceComponents: jsonb("significance_components")
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    provenance: jsonb("provenance")
      .notNull()
      .default(sql`'{}'::jsonb`),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [uniqueIndex("entity_profiles_version_idx").on(t.userId, t.projectionVersion, t.entityId)],
);

// ---------------------------------------------------------------------------
// entity_edges — VERSIONED typed relations (D5, D13)
// ---------------------------------------------------------------------------

export const entityEdges = pgTable(
  "entity_edges",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("eedge")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectionVersion: integer("projection_version").notNull(),
    fromEntityId: text("from_entity_id")
      .notNull()
      .references(() => entityNodes.id, { onDelete: "cascade" }),
    toEntityId: text("to_entity_id")
      .notNull()
      .references(() => entityNodes.id, { onDelete: "cascade" }),
    relationType: text("relation_type").$type<EntityEdgeType>().notNull(),
    weight: real("weight").notNull().default(0),
    confidence: real("confidence").notNull().default(1),
    provenance: jsonb("provenance")
      .notNull()
      .default(sql`'{}'::jsonb`),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_edges_unique_idx").on(
      t.userId,
      t.projectionVersion,
      t.relationType,
      t.fromEntityId,
      t.toEntityId,
    ),
    index("entity_edges_from_idx").on(t.userId, t.projectionVersion, t.fromEntityId),
    index("entity_edges_to_idx").on(t.userId, t.projectionVersion, t.toEntityId),
  ],
);

// ---------------------------------------------------------------------------
// entity_co_occurrence — VERSIONED weighted pair projection (D5)
// ---------------------------------------------------------------------------

export const entityCoOccurrence = pgTable(
  "entity_co_occurrence",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ecooc")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectionVersion: integer("projection_version").notNull(),
    /** Ordered pair (a < b) to dedupe the undirected edge. */
    aEntityId: text("a_entity_id")
      .notNull()
      .references(() => entityNodes.id, { onDelete: "cascade" }),
    bEntityId: text("b_entity_id")
      .notNull()
      .references(() => entityNodes.id, { onDelete: "cascade" }),
    weight: real("weight").notNull().default(0),
    count: integer("count").notNull().default(0),
    /** Distinct event families backing the pair — gates promotion (PROMOTION_MIN_FAMILIES). */
    familyCount: integer("family_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_co_occurrence_pair_idx").on(
      t.userId,
      t.projectionVersion,
      t.aEntityId,
      t.bEntityId,
    ),
    index("entity_co_occurrence_weight_idx").on(t.userId, t.projectionVersion, t.weight),
    check("entity_co_occurrence_pair_order", sql`${t.aEntityId} < ${t.bEntityId}`),
  ],
);

// ---------------------------------------------------------------------------
// projection bookkeeping — the replay safety rail (D13, D17)
// ---------------------------------------------------------------------------

/** One row per (named projection, version) replay run — watermarks, checksum, counts, status. */
export const projectionRuns = pgTable(
  "projection_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("prun")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectionName: text("projection_name").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    /** Per-source high-watermark consumed by this run. */
    sourceHighWatermark: jsonb("source_high_watermark")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Determinism check: over stable-ordered, rounded, time-invariant components only (D13). */
    checksum: text("checksum"),
    rowCounts: jsonb("row_counts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** running | completed | failed. */
    status: text("status").$type<ProjectionRunStatus>().notNull().default("running"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [index("projection_runs_name_idx").on(t.userId, t.projectionName, t.projectionVersion)],
);

/** Per-(projection, source) replay cursor proving no observation is double-counted. */
export const projectionCursors = pgTable(
  "projection_cursors",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("pcur")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectionName: text("projection_name").notNull(),
    source: text("source").$type<ObservationSource>().notNull(),
    cursor: jsonb("cursor")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [uniqueIndex("projection_cursors_unique_idx").on(t.userId, t.projectionName, t.source)],
);

/** The cutover pointer: which version each named projection currently serves (D13). */
export const activeProjectionVersions = pgTable(
  "active_projection_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("apv")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectionName: text("projection_name").notNull(),
    activeVersion: integer("active_version").notNull(),
    ...lifecycle_dates,
  },
  (t) => [uniqueIndex("active_projection_versions_unique_idx").on(t.userId, t.projectionName)],
);

/**
 * Replicache-visible projection sync state (D17). Stable logical key + a content
 * hash → synthetic `row_version`, so flipping the active projection version
 * produces per-key deltas (unchanged keys keep their version) instead of a
 * delete-all + re-add-all storm.
 */
export const projectionSyncState = pgTable(
  "projection_sync_state",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("psync")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Which Replicache-visible projection (e.g. `active_user_facts`). */
    syncSlug: text("sync_slug").notNull(),
    /** Stable logical key the client tracks. */
    stableKey: text("stable_key").notNull(),
    contentHash: text("content_hash").notNull(),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("projection_sync_state_unique_idx").on(t.userId, t.syncSlug, t.stableKey),
    index("projection_sync_state_slug_idx").on(t.userId, t.syncSlug),
  ],
);

export type Observation = typeof observations.$inferSelect;
export type EntityNode = typeof entityNodes.$inferSelect;
export type EntityIdentity = typeof entityIdentities.$inferSelect;
export type EntityProfile = typeof entityProfiles.$inferSelect;
export type EntityEdge = typeof entityEdges.$inferSelect;
export type EntityCoOccurrence = typeof entityCoOccurrence.$inferSelect;
export type ProjectionRun = typeof projectionRuns.$inferSelect;
export type ProjectionCursor = typeof projectionCursors.$inferSelect;
export type ActiveProjectionVersion = typeof activeProjectionVersions.$inferSelect;
export type ProjectionSyncState = typeof projectionSyncState.$inferSelect;
