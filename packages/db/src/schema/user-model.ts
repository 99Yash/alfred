import type {
  EntityEdgeType,
  EntityNodeKind,
  IdentityKind,
  IdentityRef,
  ObservationParticipants,
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
    /**
     * Hash over relationship-significant fields only (participants, start, …).
     * Dedup is the unique `(user_id, family_key, evidence_hash)` below — identical
     * evidence collides (dedups), changed evidence is a new hash that appends +
     * supersedes (D4). No separate `family_key:evidence_hash` string is stored;
     * a denormalized concat would just be a second source of truth a reducer
     * could compute wrong.
     */
    evidenceHash: text("evidence_hash").notNull(),
    subjectIdentity: jsonb("subject_identity").$type<IdentityRef>().notNull(),
    objectIdentity: jsonb("object_identity").$type<IdentityRef | null>(),
    /** Full participant set + recipientCount + List-Id — the fold derives pairwise edges. */
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
     * Prior active family member this row supersedes (changed evidence, D4).
     * Bound to the SAME (user_id, family_key) by the composite self-FK below — a
     * single-column FK on `id` alone only proved the target existed, letting a
     * row supersede another user's (or another family's) observation. `no action`
     * (not `set null`) because the FK now spans the NOT NULL `user_id`/`family_key`
     * columns, which can't be nulled; an append-only log never deletes a
     * superseded member except via the user cascade (which drops the whole family
     * together), so `no action` just hardens "don't strand a successor". The
     * resolver (P1) still owns multi-hop cycle detection — the `<> id` check only
     * kills the trivial 1-cycle, and the partial-unique index below makes the
     * chain DB-provably fork-free (≤1 successor per predecessor per family).
     */
    supersedesObservationId: text("supersedes_observation_id"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("observations_dedup_idx").on(t.userId, t.familyKey, t.evidenceHash),
    index("observations_source_time_idx").on(t.userId, t.source, t.occurredAt),
    index("observations_family_idx").on(t.userId, t.familyKey),
    index("observations_supersedes_idx").on(t.supersedesObservationId),
    // FK target for the family-head + supersession composite FKs: lets a head /
    // a successor bind (user, family_key, observation id) together so neither can
    // point at an observation from a different user / family. Unique because `id`
    // is the PK.
    uniqueIndex("observations_family_member_fk_idx").on(t.userId, t.familyKey, t.id),
    // At most one row may supersede a given predecessor within a family — turns the
    // supersession chain into a DB-enforced linear history. Two concurrent material
    // updates that both read prior head A collide here (the second's insert is
    // rejected) instead of both inserting and forking the chain; the P1 reducer
    // retries against the new head. Partial so the many non-superseding roots don't
    // collide on a shared NULL.
    uniqueIndex("observations_no_fork_idx")
      .on(t.userId, t.familyKey, t.supersedesObservationId)
      .where(sql`${t.supersedesObservationId} IS NOT NULL`),
    foreignKey({
      columns: [t.userId, t.familyKey, t.supersedesObservationId],
      foreignColumns: [t.userId, t.familyKey, t.id],
      name: "observations_supersedes_fk",
    }),
    check(
      "observations_no_self_supersede",
      sql`${t.supersedesObservationId} IS NULL OR ${t.supersedesObservationId} <> ${t.id}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// observation_family_heads — one active head per (user, family_key) (D4)
// ---------------------------------------------------------------------------

/**
 * The single active member of an observation family. The unique `(user_id,
 * family_key)` guarantees exactly one *head pointer* per family and lets the P1
 * reducer `upsert ... ON CONFLICT` it inside the append transaction.
 *
 * This table alone does NOT serialize the supersession chain — two concurrent
 * writers could still insert two rows both superseding prior head A and only
 * then race on the pointer. That fork is prevented one level down, by the
 * partial-unique `observations_no_fork_idx` (≤1 successor per predecessor): the
 * second insert is rejected, so the reducer must re-read the head and retry
 * (the documented CAS protocol, owned by P1; covered by the P1 concurrency
 * test). Observations stay insert-only — this is the only mutable "which one is
 * live" pointer.
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
    /** The currently-live observation for this family — bound to (user, family_key) by the composite FK below. */
    headObservationId: text("head_observation_id").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("observation_family_heads_unique_idx").on(t.userId, t.familyKey),
    index("observation_family_heads_obs_idx").on(t.headObservationId),
    // The head's (user, family_key, observation id) must all belong to the SAME
    // observations row — a plain FK on head_observation_id alone proved only that
    // the observation exists, not that it belongs to this user's family. Cascade so
    // deleting an observation can't strand a head pointing at it.
    foreignKey({
      columns: [t.userId, t.familyKey, t.headObservationId],
      foreignColumns: [observations.userId, observations.familyKey, observations.id],
      name: "observation_family_heads_obs_fk",
    }).onDelete("cascade"),
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
    /**
     * Set on the loser of a merge → points at the surviving (best-anchor) node.
     * Reads resolve through this (D16), so it is the permanent FK safety rail,
     * not free metadata. Bound to the SAME user by the composite self-FK below —
     * a single-column FK on `id` alone let a node forward to another user's node.
     * `no action` (not `set null`) because the FK now spans the NOT NULL
     * `user_id`; nodes are deleted only via the user cascade (which drops the
     * whole graph together), so `no action` just hardens "don't strand a
     * forwarder". The `<> id` check kills self-forwarding.
     */
    supersedesEntityId: text("supersedes_entity_id"),
    /** Earliest observation timestamp for this node — anchor tie-break (D2). */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    index("entity_nodes_user_idx").on(t.userId),
    index("entity_nodes_supersedes_idx").on(t.supersedesEntityId),
    // FK target for the (user, entity id) composite FKs on every table that
    // references a stable node (identities, profiles, edges, co-occurrence) and
    // for this table's own forwarding self-FK: binds the referencing row's
    // user_id to the node's own, so a row can't point at a node owned by a
    // different user. Unique because `id` is the PK.
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
    /** The stable node this identity belongs to — bound to the same user by the composite FK below. */
    entityId: text("entity_id").notNull(),
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
    /**
     * Prior identity row this one supersedes (re-anchoring on merge). Bound to
     * the SAME user by the composite self-FK below — a single-column FK on `id`
     * alone let an identity supersede another user's. `no action` (not `set
     * null`) because the FK now spans the NOT NULL `user_id`; identities are
     * deleted only via the user cascade, so `no action` just hardens "don't
     * strand a successor". The `<> id` check kills self-supersession.
     */
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
    index("entity_identities_supersedes_idx").on(t.supersedesId),
    // FK target for this table's own supersession self-FK: binds (user, id) so a
    // successor can't point at another user's identity row. Unique because `id`
    // is the PK.
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
    check("entity_identities_confidence_range", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      "entity_identities_no_self_supersede",
      sql`${t.supersedesId} IS NULL OR ${t.supersedesId} <> ${t.id}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// projection_runs — one row per (named projection, version) replay run (D13, D17)
// Declared here (ahead of the bookkeeping section) so the VERSIONED output
// tables below can FK their rows to the run that produced them.
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
      .$type<ProjectionSourceHighWatermark>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Determinism check: over stable-ordered, rounded, time-invariant components only (D13). */
    checksum: text("checksum"),
    rowCounts: jsonb("row_counts")
      .$type<ProjectionRowCounts>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** running | completed | failed. */
    status: text("status").$type<ProjectionRunStatus>().notNull().default("running"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("projection_runs_unique_idx").on(t.userId, t.projectionName, t.projectionVersion),
    index("projection_runs_name_idx").on(t.userId, t.projectionName, t.projectionVersion),
    // FK target for the active-pointer composite FK: lets `active_projection_versions`
    // bind (user, name, version, run id) together so a pointer can't name a run
    // that belongs to a different user / projection / version.
    uniqueIndex("projection_runs_active_fk_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.id,
    ),
    // FK target for the versioned output tables' run-binding FK: lets a profile /
    // edge / co-occurrence row bind (user, run id) so its data provably came from
    // one concrete run (not just "some run at this version"). Unique because `id`
    // is the PK.
    uniqueIndex("projection_runs_user_fk_idx").on(t.userId, t.id),
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
    /**
     * The concrete replay run that produced this row — bound to it by the
     * composite FK below. A projection version is SINGLE-ATTEMPT:
     * `projection_runs` is unique on (user, name, version), so a retry reuses
     * that one run row and must clear the prior attempt's rows before
     * re-projecting (`DELETE ... WHERE projection_run_id = <run>`, or drop the
     * run row and let this FK cascade). The binding is provenance, not
     * stale-vs-active discrimination: it proves the row came from one concrete
     * run, and lets a read assert the active rows are from exactly the run
     * `active_run_id` names — not merely "some row at this version". (Two
     * coexisting runs at the same version is impossible under the unique index,
     * so there is never a version-N orphan to tell apart by run id.)
     */
    projectionRunId: text("projection_run_id").notNull(),
    /** Stable node this profile describes — bound to the same user by the composite FK below. */
    entityId: text("entity_id").notNull(),
    displayName: text("display_name").notNull(),
    /** Kind lives here (versioned) — a better classifier can change it without re-minting the id (D7). */
    kind: text("kind").$type<EntityNodeKind>().notNull(),
    /** Time-invariant significance components only; final score = base(components) * recency(asOf) at read time (D6). */
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
    uniqueIndex("entity_profiles_version_idx").on(t.userId, t.projectionVersion, t.entityId),
    foreignKey({
      columns: [t.userId, t.entityId],
      foreignColumns: [entityNodes.userId, entityNodes.id],
      name: "entity_profiles_entity_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.userId, t.projectionRunId],
      foreignColumns: [projectionRuns.userId, projectionRuns.id],
      name: "entity_profiles_run_fk",
    }).onDelete("cascade"),
  ],
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
    /** The concrete replay run that produced this row — bound by the composite FK below (see entity_profiles). */
    projectionRunId: text("projection_run_id").notNull(),
    /** Stable endpoint nodes — both bound to the same user by the composite FKs below. */
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    relationType: text("relation_type").$type<EntityEdgeType>().notNull(),
    weight: real("weight").notNull().default(0),
    confidence: real("confidence").notNull().default(1),
    provenance: jsonb("provenance")
      .$type<ProjectionProvenance>()
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
      columns: [t.userId, t.projectionRunId],
      foreignColumns: [projectionRuns.userId, projectionRuns.id],
      name: "entity_edges_run_fk",
    }).onDelete("cascade"),
    check("entity_edges_weight_nonnegative", sql`${t.weight} >= 0`),
    check("entity_edges_confidence_range", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
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
    /** The concrete replay run that produced this row — bound by the composite FK below (see entity_profiles). */
    projectionRunId: text("projection_run_id").notNull(),
    /** Ordered pair (a < b) to dedupe the undirected edge — both bound to the same user by the composite FKs below. */
    aEntityId: text("a_entity_id").notNull(),
    bEntityId: text("b_entity_id").notNull(),
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
      columns: [t.userId, t.projectionRunId],
      foreignColumns: [projectionRuns.userId, projectionRuns.id],
      name: "entity_co_occurrence_run_fk",
    }).onDelete("cascade"),
    check("entity_co_occurrence_pair_order", sql`${t.aEntityId} < ${t.bEntityId}`),
    check("entity_co_occurrence_weight_nonnegative", sql`${t.weight} >= 0`),
    check("entity_co_occurrence_count_nonnegative", sql`${t.count} >= 0`),
    check("entity_co_occurrence_family_count_nonnegative", sql`${t.familyCount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// projection bookkeeping — the replay safety rail (D13, D17)
// (`projection_runs` itself is declared earlier, above the versioned tables, so
// those tables can bind their output rows to the run that produced them.)
// ---------------------------------------------------------------------------

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
    /** The replay run this cursor belongs to — its (user, name, version) bound to the run by the composite FK below. */
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
    // The cursor's (user, name, version, run id) must all belong to the SAME
    // projection_runs row — a plain FK on projection_run_id alone proved only that
    // the run exists, not that its user/name/version match the cursor's. Reuses the
    // `projection_runs_active_fk_idx` 4-col unique target.
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
  ],
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
    /** The concrete run this pointer activates — bound to (user, name, version) by the composite FK below. */
    activeRunId: text("active_run_id").notNull(),
    activeVersion: integer("active_version").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("active_projection_versions_unique_idx").on(t.userId, t.projectionName),
    index("active_projection_versions_run_idx").on(t.userId, t.activeRunId),
    // The pointer's (user, name, version, run id) must all belong to the SAME
    // projection_runs row — a plain FK on active_run_id alone proved only that
    // the run exists, not that its user/name/version match the pointer's. (The
    // "completed-only" guard stays in the activation helper, P1 — a FK can't
    // assert the target row's status.)
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
  ],
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
    check("projection_sync_state_row_version_nonnegative", sql`${t.rowVersion} >= 0`),
  ],
);

export type Observation = typeof observations.$inferSelect;
export type ObservationFamilyHead = typeof observationFamilyHeads.$inferSelect;
export type EntityNode = typeof entityNodes.$inferSelect;
export type EntityIdentity = typeof entityIdentities.$inferSelect;
export type EntityProfile = typeof entityProfiles.$inferSelect;
export type EntityEdge = typeof entityEdges.$inferSelect;
export type EntityCoOccurrence = typeof entityCoOccurrence.$inferSelect;
export type ProjectionRun = typeof projectionRuns.$inferSelect;
export type ProjectionCursor = typeof projectionCursors.$inferSelect;
export type ActiveProjectionVersion = typeof activeProjectionVersions.$inferSelect;
export type ProjectionSyncState = typeof projectionSyncState.$inferSelect;
