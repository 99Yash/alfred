import type {
  EntityEdgeType,
  EntityIdentityKind,
  EntityNodeKind,
  IdentityRef,
  ObservationParticipants,
  ObservationSubject,
  ObservationKind,
  ObservationPayload,
  ObservationSource,
  ProjectionCursorValue,
  ProjectionProvenance,
  ProjectionRunStatus,
  ProjectionRowCounts,
  ProjectionSourceHighWatermark,
  SignificanceComponents,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

/**
 * User-model substrate (ADR-0067). The append-only `observations` log is the
 * system of record. Everything else is a replayable projection over it.
 *
 * Stable layer (`entity_nodes`, `entity_identities`): content-addressed ids that
 * other tables reference, never versioned. A merge leaves a forwarding pointer.
 * Versioned layer (`entity_profiles`, `entity_edges`, `entity_co_occurrence`):
 * rebuilt per `projection_version`, then made live by moving the active pointer.
 *
 * The names differ from the legacy `entities` / `entity_relations` in `memory.ts`
 * because both exist until cutover (D10).
 */

// ---------------------------------------------------------------------------
// observations: append-only system of record (D1, D4)
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
    source: text("source").$type<ObservationSource>().notNull(),
    kind: text("kind").$type<ObservationKind>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Stable event id, e.g. `gmail:<message_id>` (D4). */
    familyKey: text("family_key").notNull(),
    /** Hash of the relationship fields only. Changed evidence appends a superseding row (D4). */
    evidenceHash: text("evidence_hash").notNull(),
    /** An identity, or the user (`{kind:'user'}`) for self-facts. */
    subjectIdentity: jsonb("subject_identity").$type<ObservationSubject>().notNull(),
    objectIdentity: jsonb("object_identity").$type<IdentityRef | null>(),
    participants: jsonb("participants")
      .$type<ObservationParticipants>()
      .notNull()
      .default(sql`'{"items":[],"recipientCount":0}'::jsonb`),
    payload: jsonb("payload")
      .$type<ObservationPayload>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    schemaVersion: integer("schema_version").notNull().default(1),
    reducerVersion: integer("reducer_version").notNull().default(1),
    /**
     * The family member this row replaces. The composite self-FK keeps it in the
     * same user and family. The writer owns multi-hop cycle detection.
     */
    supersedesObservationId: text("supersedes_observation_id"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("observations_dedup_idx").on(t.userId, t.familyKey, t.evidenceHash),
    index("observations_source_time_idx").on(t.userId, t.source, t.occurredAt),
    // No (user_id, family_key) index: both unique indexes below start with it.
    index("observations_supersedes_idx").on(t.supersedesObservationId),
    // Target for the composite FKs that keep a pointer in one user and family.
    uniqueIndex("observations_family_member_fk_idx").on(t.userId, t.familyKey, t.id),
    // One successor per predecessor, so concurrent writers collide and retry
    // instead of forking the chain.
    uniqueIndex("observations_no_fork_idx")
      .on(t.userId, t.familyKey, t.supersedesObservationId)
      .where(sql`${t.supersedesObservationId} IS NOT NULL`),
    // One root per family. The no-fork index skips NULL, so two first writers
    // would otherwise both insert a root.
    uniqueIndex("observations_single_root_idx")
      .on(t.userId, t.familyKey)
      .where(sql`${t.supersedesObservationId} IS NULL`),
    foreignKey({
      columns: [t.userId, t.familyKey, t.supersedesObservationId],
      foreignColumns: [t.userId, t.familyKey, t.id],
      name: "observations_supersedes_fk",
    }),
    check(
      "observations_no_self_supersede",
      sql`${t.supersedesObservationId} IS NULL OR ${t.supersedesObservationId} <> ${t.id}`,
    ),
    check("observations_schema_version_positive", sql`${t.schemaVersion} >= 1`),
    check("observations_reducer_version_positive", sql`${t.reducerVersion} >= 1`),
    // Dedup keys match by exact bytes, so an empty or padded key breaks dedup.
    // `[[:space:]]` instead of `btrim()`, which trims only spaces.
    // Byte caps keep the composite btree keys under the index tuple limit.
    check(
      "observations_family_key_nonempty",
      sql`length(${t.familyKey}) > 0 AND octet_length(${t.familyKey}) <= 512 AND ${t.familyKey} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
    check(
      "observations_evidence_hash_nonempty",
      sql`length(${t.evidenceHash}) > 0 AND octet_length(${t.evidenceHash}) <= 256 AND ${t.evidenceHash} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// observation_family_heads: one live head per family (D4)
// ---------------------------------------------------------------------------

/**
 * The one live observation per family. The writer upserts it in the append
 * transaction. `observations_no_fork_idx` prevents the fork, not this table.
 */
export const observationFamilyHeads = pgTable(
  "observation_family_heads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("ofh")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    familyKey: text("family_key").notNull(),
    headObservationId: text("head_observation_id").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("observation_family_heads_unique_idx").on(t.userId, t.familyKey),
    index("observation_family_heads_obs_idx").on(t.headObservationId),
    // Composite, so the head stays in this user's family.
    foreignKey({
      columns: [t.userId, t.familyKey, t.headObservationId],
      foreignColumns: [observations.userId, observations.familyKey, observations.id],
      name: "observation_family_heads_obs_fk",
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// entity_nodes: stable nodes (D2)
// ---------------------------------------------------------------------------

export const entityNodes = pgTable(
  "entity_nodes",
  {
    /** Minted by `computeStableEntityId`. No default. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    canonicalIdentity: jsonb("canonical_identity").$type<IdentityRef>().notNull(),
    /** On a merge loser, points at the survivor. Reads resolve through it (D16). */
    supersedesEntityId: text("supersedes_entity_id"),
    /**
     * Earliest observation time, the merge tie-break (D2). No default: a
     * wall-clock value would change on replay, so a missing value must fail.
     */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    // No (user_id) index: `entity_nodes_user_fk_idx` starts with it.
    index("entity_nodes_supersedes_idx").on(t.supersedesEntityId),
    // Target for the (user, entity id) FKs, so no row points at another user's node.
    uniqueIndex("entity_nodes_user_fk_idx").on(t.userId, t.id),
    foreignKey({
      columns: [t.userId, t.supersedesEntityId],
      foreignColumns: [t.userId, t.id],
      name: "entity_nodes_supersedes_fk",
    }),
    check(
      "entity_nodes_no_self_supersede",
      sql`${t.supersedesEntityId} IS NULL OR ${t.supersedesEntityId} <> ${t.id}`,
    ),
    // Every substrate table binds to this id, so pin the minted shape.
    check("entity_nodes_id_shape", sql`${t.id} ~ '^ent_[a-z2-7]{26}$'`),
  ],
);

// ---------------------------------------------------------------------------
// entity_identities: stable typed identity keys (D2)
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
    entityId: text("entity_id").notNull(),
    /** The `(kind, source)` pair is checked by `entityIdentitySourceKindSchema`, not a CHECK. */
    kind: text("kind").$type<EntityIdentityKind>().notNull(),
    /** Canonical value, e.g. a lowercased email. */
    value: text("value").notNull(),
    confidence: real("confidence").notNull().default(1),
    source: text("source").$type<ObservationSource>().notNull(),
    /** Gates the directory anchor tier in `identityAnchorRank` (D2). Not a general tie-break. */
    verified: boolean("verified").notNull().default(false),
    /** Set by a user pin or correction. Anchor tier 1 (D2). */
    userPinned: boolean("user_pinned").notNull().default(false),
    /** No default: a replay must supply the observation time. */
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    supersedesId: text("supersedes_id"),
    provenance: jsonb("provenance")
      .$type<ProjectionProvenance>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    // Live rows only. A freed `github_login` or a reused `owner/repo` can later
    // belong to a different entity, so closed history may repeat a value.
    uniqueIndex("entity_identities_active_unique_idx")
      .on(t.userId, t.kind, t.value)
      .where(sql`${t.validUntil} IS NULL`),
    index("entity_identities_entity_idx").on(t.userId, t.entityId),
    index("entity_identities_supersedes_idx").on(t.supersedesId),
    // Target for the supersession self-FK.
    uniqueIndex("entity_identities_user_fk_idx").on(t.userId, t.id),
    foreignKey({
      columns: [t.userId, t.entityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_identities_entity_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.supersedesId],
      foreignColumns: [t.userId, t.id],
      name: "entity_identities_supersedes_fk",
    }),
    // An empty or padded dedup value merges unrelated identities. The write
    // boundary does the per-kind canonical check.
    check(
      "entity_identities_value_nonempty",
      sql`length(${t.value}) > 0 AND octet_length(${t.value}) <= 1024 AND ${t.value} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
    check(
      "entity_identities_valid_window",
      sql`${t.validUntil} IS NULL OR ${t.validUntil} >= ${t.validFrom}`,
    ),
    check("entity_identities_confidence_range", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      "entity_identities_no_self_supersede",
      sql`${t.supersedesId} IS NULL OR ${t.supersedesId} <> ${t.id}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// projection_runs (D13, D17). Declared first so the versioned tables can FK to it.
// ---------------------------------------------------------------------------

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
    sourceHighWatermark: jsonb("source_high_watermark")
      .$type<ProjectionSourceHighWatermark>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Over time-invariant, rounded, stable-ordered components only (D13). */
    checksum: text("checksum"),
    rowCounts: jsonb("row_counts")
      .$type<ProjectionRowCounts>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").$type<ProjectionRunStatus>().notNull().default("running"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("projection_runs_unique_idx").on(t.userId, t.projectionName, t.projectionVersion),
    // Target for the run FKs on pointers, cursors, and versioned rows. It binds
    // name and version too, so a v1 row cannot point at a v2 run.
    uniqueIndex("projection_runs_active_fk_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.id,
    ),
    check("projection_runs_version_positive", sql`${t.projectionVersion} >= 1`),
    check(
      "projection_runs_name_nonempty",
      sql`length(${t.projectionName}) > 0 AND octet_length(${t.projectionName}) <= 128 AND ${t.projectionName} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
    check("projection_runs_status_valid", sql`${t.status} IN ('running', 'completed', 'failed')`),
    // Two forbidden pairs, not an allowlist, so a bad status trips only
    // `projection_runs_status_valid`. Activation still checks status in code.
    check(
      "projection_runs_completed_at_consistency",
      sql`NOT (${t.status} = 'running' AND ${t.completedAt} IS NOT NULL) AND NOT (${t.status} = 'completed' AND ${t.completedAt} IS NULL)`,
    ),
    check(
      "projection_runs_completed_checksum_present",
      sql`${t.status} <> 'completed' OR (${t.checksum} IS NOT NULL AND length(${t.checksum}) > 0 AND octet_length(${t.checksum}) <= 256 AND ${t.checksum} !~ '^[[:space:]]|[[:space:]]$')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// entity_profiles: versioned display, kind, significance (D6, D7, D13)
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
    /** `projection_runs` serves many projections, so the version alone is ambiguous. */
    projectionName: text("projection_name").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    /**
     * A version runs once. A retry reuses the run row and deletes its old rows
     * by `projection_run_id` first.
     */
    projectionRunId: text("projection_run_id").notNull(),
    entityId: text("entity_id").notNull(),
    displayName: text("display_name").notNull(),
    /** Versioned, so a better classifier can change it without a new id (D7). */
    kind: text("kind").$type<EntityNodeKind>().notNull(),
    /** Time-invariant parts only. Recency is applied at read time (D6). */
    significanceComponents: jsonb("significance_components")
      .$type<SignificanceComponents>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    provenance: jsonb("provenance")
      .$type<ProjectionProvenance>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_profiles_version_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.entityId,
    ),
    index("entity_profiles_run_idx").on(t.userId, t.projectionRunId),
    foreignKey({
      columns: [t.userId, t.entityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_profiles_entity_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.projectionName, t.projectionVersion, t.projectionRunId],
      foreignColumns: [
        projectionRuns.userId,
        projectionRuns.projectionName,
        projectionRuns.projectionVersion,
        projectionRuns.id,
      ],
      name: "entity_profiles_run_fk",
    }).onDelete("cascade"),
    check("entity_profiles_version_positive", sql`${t.projectionVersion} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// entity_edges: versioned typed relations (D5, D13)
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
    projectionName: text("projection_name").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    projectionRunId: text("projection_run_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    relationType: text("relation_type").$type<EntityEdgeType>().notNull(),
    weight: real("weight").notNull().default(0),
    confidence: real("confidence").notNull().default(1),
    provenance: jsonb("provenance")
      .$type<ProjectionProvenance>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** No default: `now()` would differ between identical replays. */
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_edges_unique_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.relationType,
      t.fromEntityId,
      t.toEntityId,
    ),
    // Versions repeat across projections, so index the name too.
    index("entity_edges_from_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.fromEntityId,
    ),
    index("entity_edges_to_idx").on(t.userId, t.projectionName, t.projectionVersion, t.toEntityId),
    index("entity_edges_run_idx").on(t.userId, t.projectionRunId),
    foreignKey({
      columns: [t.userId, t.fromEntityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_edges_from_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.toEntityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_edges_to_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.projectionName, t.projectionVersion, t.projectionRunId],
      foreignColumns: [
        projectionRuns.userId,
        projectionRuns.projectionName,
        projectionRuns.projectionVersion,
        projectionRuns.id,
      ],
      name: "entity_edges_run_fk",
    }).onDelete("cascade"),
    check("entity_edges_version_positive", sql`${t.projectionVersion} >= 1`),
    check("entity_edges_weight_nonnegative", sql`${t.weight} >= 0`),
    check("entity_edges_confidence_range", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      "entity_edges_valid_window",
      sql`${t.validUntil} IS NULL OR ${t.validUntil} >= ${t.validFrom}`,
    ),
    // A self-edge is a 1-cycle for traversal. Co-occurrence gets this from `a < b`.
    check("entity_edges_no_self_relation", sql`${t.fromEntityId} <> ${t.toEntityId}`),
  ],
);

// ---------------------------------------------------------------------------
// entity_co_occurrence: versioned weighted pairs (D5)
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
    projectionName: text("projection_name").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    projectionRunId: text("projection_run_id").notNull(),
    /** Ordered pair (a < b), so one undirected edge has one row. */
    aEntityId: text("a_entity_id").notNull(),
    bEntityId: text("b_entity_id").notNull(),
    weight: real("weight").notNull().default(0),
    count: integer("count").notNull().default(0),
    /** Distinct event families. Gates promotion (`PROMOTION_MIN_FAMILIES`). */
    familyCount: integer("family_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("entity_co_occurrence_pair_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.aEntityId,
      t.bEntityId,
    ),
    // Name included because versions repeat across projections.
    index("entity_co_occurrence_weight_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.weight,
    ),
    index("entity_co_occurrence_run_idx").on(t.userId, t.projectionRunId),
    foreignKey({
      columns: [t.userId, t.aEntityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_co_occurrence_a_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.bEntityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_co_occurrence_b_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.projectionName, t.projectionVersion, t.projectionRunId],
      foreignColumns: [
        projectionRuns.userId,
        projectionRuns.projectionName,
        projectionRuns.projectionVersion,
        projectionRuns.id,
      ],
      name: "entity_co_occurrence_run_fk",
    }).onDelete("cascade"),
    check("entity_co_occurrence_version_positive", sql`${t.projectionVersion} >= 1`),
    check("entity_co_occurrence_pair_order", sql`${t.aEntityId} < ${t.bEntityId}`),
    check("entity_co_occurrence_weight_nonnegative", sql`${t.weight} >= 0`),
    check("entity_co_occurrence_count_nonnegative", sql`${t.count} >= 0`),
    check("entity_co_occurrence_family_count_nonnegative", sql`${t.familyCount} >= 0`),
    check("entity_co_occurrence_family_count_lte_count", sql`${t.familyCount} <= ${t.count}`),
    check("entity_co_occurrence_weight_requires_count", sql`${t.weight} = 0 OR ${t.count} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// projection bookkeeping (D13, D17)
// ---------------------------------------------------------------------------

/** Per-run, per-source replay cursor, so no observation counts twice. */
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
    projectionRunId: text("projection_run_id").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    source: text("source").$type<ObservationSource>().notNull(),
    cursor: jsonb("cursor")
      .$type<ProjectionCursorValue>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("projection_cursors_unique_idx").on(t.userId, t.projectionRunId, t.source),
    index("projection_cursors_version_idx").on(t.userId, t.projectionName, t.projectionVersion),
    foreignKey({
      columns: [t.userId, t.projectionName, t.projectionVersion, t.projectionRunId],
      foreignColumns: [
        projectionRuns.userId,
        projectionRuns.projectionName,
        projectionRuns.projectionVersion,
        projectionRuns.id,
      ],
      name: "projection_cursors_run_fk",
    }).onDelete("cascade"),
    check("projection_cursors_version_positive", sql`${t.projectionVersion} >= 1`),
    check(
      "projection_cursors_name_nonempty",
      sql`length(${t.projectionName}) > 0 AND octet_length(${t.projectionName}) <= 128 AND ${t.projectionName} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
  ],
);

/** Which run each named projection serves now (D13). */
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
    activeRunId: text("active_run_id").notNull(),
    activeVersion: integer("active_version").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("active_projection_versions_unique_idx").on(t.userId, t.projectionName),
    index("active_projection_versions_run_idx").on(t.userId, t.activeRunId),
    // An FK cannot read status, so the activation code checks the run is completed.
    foreignKey({
      columns: [t.userId, t.projectionName, t.activeVersion, t.activeRunId],
      foreignColumns: [
        projectionRuns.userId,
        projectionRuns.projectionName,
        projectionRuns.projectionVersion,
        projectionRuns.id,
      ],
      name: "active_projection_versions_run_fk",
    }),
    check("active_projection_versions_version_positive", sql`${t.activeVersion} >= 1`),
    check(
      "active_projection_versions_name_nonempty",
      sql`length(${t.projectionName}) > 0 AND octet_length(${t.projectionName}) <= 128 AND ${t.projectionName} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// active projection views: read versioned rows only through these
// ---------------------------------------------------------------------------

export const activeEntityProfiles = pgView("active_entity_profiles", {
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  projectionName: text("projection_name").notNull(),
  projectionVersion: integer("projection_version").notNull(),
  projectionRunId: text("projection_run_id").notNull(),
  entityId: text("entity_id").notNull(),
  displayName: text("display_name").notNull(),
  kind: text("kind").$type<EntityNodeKind>().notNull(),
  significanceComponents: jsonb("significance_components")
    .$type<SignificanceComponents>()
    .notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  provenance: jsonb("provenance").$type<ProjectionProvenance>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}).as(sql`
  SELECT
    ep.id,
    ep.user_id,
    ep.projection_name,
    ep.projection_version,
    ep.projection_run_id,
    ep.entity_id,
    ep.display_name,
    ep.kind,
    ep.significance_components,
    ep.last_seen_at,
    ep.provenance,
    ep.computed_at,
    ep.created_at,
    ep.updated_at
  FROM entity_profiles ep
  INNER JOIN active_projection_versions apv
    ON apv.user_id = ep.user_id
   AND apv.projection_name = ep.projection_name
   AND apv.active_version = ep.projection_version
   AND apv.active_run_id = ep.projection_run_id
`);

export const activeEntityEdges = pgView("active_entity_edges", {
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  projectionName: text("projection_name").notNull(),
  projectionVersion: integer("projection_version").notNull(),
  projectionRunId: text("projection_run_id").notNull(),
  fromEntityId: text("from_entity_id").notNull(),
  toEntityId: text("to_entity_id").notNull(),
  relationType: text("relation_type").$type<EntityEdgeType>().notNull(),
  weight: real("weight").notNull(),
  confidence: real("confidence").notNull(),
  provenance: jsonb("provenance").$type<ProjectionProvenance>().notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}).as(sql`
  SELECT
    ee.id,
    ee.user_id,
    ee.projection_name,
    ee.projection_version,
    ee.projection_run_id,
    ee.from_entity_id,
    ee.to_entity_id,
    ee.relation_type,
    ee.weight,
    ee.confidence,
    ee.provenance,
    ee.valid_from,
    ee.valid_until,
    ee.created_at,
    ee.updated_at
  FROM entity_edges ee
  INNER JOIN active_projection_versions apv
    ON apv.user_id = ee.user_id
   AND apv.projection_name = ee.projection_name
   AND apv.active_version = ee.projection_version
   AND apv.active_run_id = ee.projection_run_id
`);

export const activeEntityCoOccurrence = pgView("active_entity_co_occurrence", {
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  projectionName: text("projection_name").notNull(),
  projectionVersion: integer("projection_version").notNull(),
  projectionRunId: text("projection_run_id").notNull(),
  aEntityId: text("a_entity_id").notNull(),
  bEntityId: text("b_entity_id").notNull(),
  weight: real("weight").notNull(),
  count: integer("count").notNull(),
  familyCount: integer("family_count").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}).as(sql`
  SELECT
    eco.id,
    eco.user_id,
    eco.projection_name,
    eco.projection_version,
    eco.projection_run_id,
    eco.a_entity_id,
    eco.b_entity_id,
    eco.weight,
    eco.count,
    eco.family_count,
    eco.last_seen_at,
    eco.created_at,
    eco.updated_at
  FROM entity_co_occurrence eco
  INNER JOIN active_projection_versions apv
    ON apv.user_id = eco.user_id
   AND apv.projection_name = eco.projection_name
   AND apv.active_version = eco.projection_version
   AND apv.active_run_id = eco.projection_run_id
`);

/**
 * Replicache sync state per projected row (D17). A content hash drives
 * `row_version`, so an active-version flip sends only the changed keys.
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
    syncSlug: text("sync_slug").notNull(),
    stableKey: text("stable_key").notNull(),
    contentHash: text("content_hash").notNull(),
    rowVersion: integer("row_version").notNull().default(0),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("projection_sync_state_unique_idx").on(t.userId, t.syncSlug, t.stableKey),
    // No (user_id, sync_slug) index: the unique index starts with it.
    check("projection_sync_state_row_version_nonnegative", sql`${t.rowVersion} >= 0`),
    check(
      "projection_sync_state_sync_slug_nonempty",
      sql`length(${t.syncSlug}) > 0 AND octet_length(${t.syncSlug}) <= 128 AND ${t.syncSlug} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
    check(
      "projection_sync_state_stable_key_nonempty",
      sql`length(${t.stableKey}) > 0 AND octet_length(${t.stableKey}) <= 1024 AND ${t.stableKey} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
    check(
      "projection_sync_state_content_hash_nonempty",
      sql`length(${t.contentHash}) > 0 AND octet_length(${t.contentHash}) <= 256 AND ${t.contentHash} !~ '^[[:space:]]|[[:space:]]$'`,
    ),
  ],
);

export type Observation = typeof observations.$inferSelect;

export type ObservationFamilyHead = typeof observationFamilyHeads.$inferSelect;

export type EntityNode = typeof entityNodes.$inferSelect;

export type EntityIdentity = typeof entityIdentities.$inferSelect;

export type EntityProfile = typeof entityProfiles.$inferSelect;

export type EntityEdge = typeof entityEdges.$inferSelect;

export type NewEntityEdge = typeof entityEdges.$inferInsert;

export type EntityCoOccurrence = typeof entityCoOccurrence.$inferSelect;

export type ActiveEntityProfile = typeof activeEntityProfiles.$inferSelect;

export type ActiveEntityEdge = typeof activeEntityEdges.$inferSelect;

export type ActiveEntityCoOccurrence = typeof activeEntityCoOccurrence.$inferSelect;

export type ProjectionRun = typeof projectionRuns.$inferSelect;

export type ProjectionCursor = typeof projectionCursors.$inferSelect;

export type ActiveProjectionVersion = typeof activeProjectionVersions.$inferSelect;

export type ProjectionSyncState = typeof projectionSyncState.$inferSelect;
