import type {
  EntityEdgeType,
  EntityNodeKind,
  IdentityKind,
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
    /**
     * Who/what the observation is about — a cross-source identity OR the user
     * themselves (`{kind:'user'}`, see `ObservationSubject`). `source='user'|
     * 'alfred_chat'` observations and self-facts (timezone/location/standing
     * instructions) bind to the user subject, which has no `IdentityRef`; column
     * name kept (renaming jsonb is a migration, widening its `$type` is not).
     */
    subjectIdentity: jsonb("subject_identity").$type<ObservationSubject>().notNull(),
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
    // No standalone (user_id, family_key) index — it is a left-prefix of both
    // `observations_dedup_idx` and `observations_family_member_fk_idx`, which the
    // planner already uses for (user_id, family_key) lookups. An extra btree on an
    // append/replay-heavy log is pure write tax for no new access path.
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
    // At most one ROOT per family — the mirror of `observations_no_fork_idx`.
    // That index serializes successors (≤1 per predecessor) but is partial on
    // `IS NOT NULL`, so it says nothing about the chain's HEAD: two rows with
    // different `evidence_hash` and `supersedes_observation_id IS NULL` are two
    // independent roots, neither colliding on the dedup index (distinct hashes)
    // nor on no-fork (both NULL, excluded) — a family forked at the root. That
    // is the exact race when two writers both see "no head yet" and each inserts
    // a first member. Pin it: one unsuperseded root per (user, family_key), so a
    // family is a single linear chain end-to-end, not just below the head. The
    // second concurrent insert collides here and the P1 reducer retries against
    // the now-existing head (the same CAS protocol no-fork documents).
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
    // Versions are 1-based (the column defaults are 1). A 0/negative version is a
    // reducer bug, never a legal value — pin it so the "numeric invariants have DB
    // checks" contract (D13) holds for the version columns too, not just weights.
    check("observations_schema_version_positive", sql`${t.schemaVersion} >= 1`),
    check("observations_reducer_version_positive", sql`${t.reducerVersion} >= 1`),
    // `family_key` and `evidence_hash` are the two idempotency rails: dedup is
    // `(user_id, family_key, evidence_hash)` and the family/supersession chain is
    // keyed on `family_key`. An empty string in either is silent corruption a
    // shape-only `notNull()` can't catch — an empty `family_key` collapses every
    // such observation into one bogus family, and an empty `evidence_hash` makes
    // every member of a family dedup onto the first. Both can only come from an
    // application bug (a real event always has a stable id + a hash), so pin them
    // non-empty at the DB, same posture as the id-shape / version checks. (The P1
    // observation-insert parser will also enforce this above the DB.)
    check("observations_family_key_nonempty", sql`length(${t.familyKey}) > 0`),
    check("observations_evidence_hash_nonempty", sql`length(${t.evidenceHash}) > 0`),
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
    /**
     * Earliest OBSERVATION timestamp for this node — the merge-survivor tie-break
     * after anchor rank (D2). Read at the fold, so it must be deterministic across
     * replays: the write API (`makeEntityNodeInsert`) REQUIRES the caller to pass
     * the observation's `occurredAt`, never a wall clock. The `defaultNow()` is a
     * degenerate fallback for a direct insert that bypasses that API (which no P1+
     * writer is allowed to do) — relying on it would leak build/replay time into
     * merge ordering and break D13 determinism.
     */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    // No standalone (user_id) index — it is a left-prefix of the unique
    // `entity_nodes_user_fk_idx` (user_id, id), which serves "all nodes for a
    // user" scans equally. A second btree would only tax writes.
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
    // `id` is content-addressed — minted ONLY by `computeStableEntityId`, which
    // emits `ent_<26 base32 chars>` (HMAC-SHA256 truncated to 128 bits, RFC-4648
    // lowercase base32: `[a-z2-7]`). It has no DB default and no random fallback,
    // so a malformed id can only come from an application bug — and since this id
    // is the FK contract every other substrate table binds to, a bad one is a
    // permanent, silently-spreading corruption. Pin the shape at the DB so a P1+
    // writer can never persist an id the projection layer would refuse to re-mint.
    check("entity_nodes_id_shape", sql`${t.id} ~ '^ent_[a-z2-7]{26}$'`),
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
    /**
     * True for a hard-verified identity (Workspace directory, confirmed bridge).
     * Gates the tier-2 directory anchor slot in `identityAnchorRank` (D2/D3): a
     * `google_directory_id` anchors at `directoryVerified` only when verified,
     * else it falls back to the provider-account tier. NOT a general tie-break.
     */
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
    /** Provenance: originating observation ids — typed like the other projection envelopes (not bare jsonb → unknown). */
    provenance: jsonb("provenance")
      .$type<ProjectionProvenance>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    // Dedup is over the ACTIVE row only (`valid_until IS NULL`), not all history.
    // The table is temporal (`valid_from`/`valid_until` + `supersedes_id`), and
    // some kinds are MUTABLE+REUSABLE: a freed `github_login` is reclaimable by
    // another account, and a `github_repository_full_name` (`owner/repo`) redirect
    // can be overridden by a new repo taking the old name. When that happens the
    // old row is closed (`valid_until` stamped) and a NEW row for the SAME
    // `(kind, value)` must bind to a DIFFERENT entity — a globally-unique index
    // would force a false cross-entity bridge (or block the legitimate re-anchor)
    // for exactly the identifiers the temporal columns exist to track. Partial so
    // at most one LIVE identity holds a `(kind, value)`, while closed history may
    // repeat it. (Resolution joins read live rows; D2's "dedup index" is the live set.)
    uniqueIndex("entity_identities_active_unique_idx")
      .on(t.userId, t.kind, t.value)
      .where(sql`${t.validUntil} IS NULL`),
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
    // `value` is the live dedup key (it feeds `entity_identities_active_unique_idx`
    // and is the join target observations resolve through), so an empty or
    // whitespace-padded value is a merge magnet / split-brain — the exact failure
    // this substrate exists to prevent. The DB can't enforce per-kind CASE
    // canonicalization (that needs `kind` + the contract canonicalizer, done at
    // the write boundary), but it CAN pin the kind-independent floor: non-empty and
    // no surrounding whitespace, the same posture as the `family_key`/`evidence_hash`
    // and `entity_nodes.id`-shape rails.
    check(
      "entity_identities_value_nonempty",
      sql`length(${t.value}) > 0 AND ${t.value} = btrim(${t.value})`,
    ),
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
    // No separate (user_id, projection_name, projection_version) index — that is
    // EXACTLY the column list of `projection_runs_unique_idx` above, so a
    // non-unique duplicate buys nothing and only taxes writes.
    // FK target for BOTH the active-pointer composite FK and the versioned
    // output tables' run-binding FK: lets `active_projection_versions` /
    // `entity_profiles` / `entity_edges` / `entity_co_occurrence` bind
    // (user, name, version, run id) together so a pointer/output row can't name a
    // run that belongs to a different user / projection / version. Binding the
    // row's own name+version to the run's is what stops a v1-tagged (or
    // foreign-projection) row from pointing at a v2 / other-projection run and
    // being pulled into the wrong active view. Unique because `id` is the PK, so
    // the name+version prefix keeps it a valid 1:1 FK target.
    uniqueIndex("projection_runs_active_fk_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.id,
    ),
    check("projection_runs_version_positive", sql`${t.projectionVersion} >= 1`),
    // `projection_name` is a replay/binding identity key (it feeds
    // `projection_runs_unique_idx` and is the name half every versioned output /
    // pointer / cursor row binds back to). An empty or whitespace-padded name
    // collapses unrelated named projections into one unique slot — same merge-
    // magnet failure as the `entity_identities.value` / `family_key` rails, so it
    // gets the same kind-independent floor (non-empty + no surrounding whitespace).
    check(
      "projection_runs_name_nonempty",
      sql`length(${t.projectionName}) > 0 AND ${t.projectionName} = btrim(${t.projectionName})`,
    ),
    // `status` is typed `ProjectionRunStatus` but stored as bare text — the DB
    // can't see the TS union, so pin the legal set here (a stray status would
    // otherwise sail past the type at any raw writer).
    check("projection_runs_status_valid", sql`${t.status} IN ('running', 'completed', 'failed')`),
    // `completed_at` is the terminal-cutover instant the P1 activation guard reads,
    // so it must agree with `status`: a still-`running` run has no completion time;
    // a `completed` run MUST have one (the active pointer only cuts over to
    // completed runs — D13). `failed` is left free (a run may record when it gave
    // up). Phrased as two forbidden pairings (running-with-time, completed-without)
    // rather than an allowlist of legal (status, completed_at) tuples so it stays
    // ORTHOGONAL to `projection_runs_status_valid`: an out-of-enum status trips ONLY
    // the status rail, not this one too — otherwise a bogus status violates both and
    // which one Postgres reports is nondeterministic. The completed-only ACTIVATION
    // guard still lives in the P1 helper (a FK can't read status).
    check(
      "projection_runs_completed_at_consistency",
      sql`NOT (${t.status} = 'running' AND ${t.completedAt} IS NOT NULL) AND NOT (${t.status} = 'completed' AND ${t.completedAt} IS NULL)`,
    ),
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
    /**
     * The named projection that produced this row (D13). `projection_runs` is
     * GENERIC — it tracks every named projection over this log, not just
     * `user-model` (P4's `user_facts` projection reuses it) — so the output rows
     * must carry the name and bind it, exactly like `projection_cursors` /
     * `active_projection_versions` already do. Without it, `projection_version`
     * is a bare integer shared across projections: a `user_facts` v1 run and a
     * `user-model` v1 run collide on the `(user, version, entity)` unique slot,
     * and the run FK (which omitted name) would happily tie this row to a run of
     * a different projection. The unique index + the 4-column run FK below both
     * include it; the run FK reuses `projection_runs_active_fk_idx`.
     */
    projectionName: text("projection_name").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    /**
     * The concrete replay run that produced this row — bound to it by the
     * composite FK below, which spans `projection_name` + `projection_version`
     * too: the FK target is `projection_runs(user_id, projection_name,
     * projection_version, id)`, so this row's name + version must equal the
     * named run's. Without that, the columns are independent and a reducer bug
     * could write `projection_version = 1` (or a foreign name) on a row whose
     * `projection_run_id` named a version-2 / differently-named run; a read
     * filtering by run id would then pull the wrong row into an active view. A
     * projection version is SINGLE-ATTEMPT: `projection_runs` is unique on
     * (user, name, version), so a retry reuses that one run row and must clear
     * the prior attempt's rows before re-projecting (`DELETE ... WHERE
     * projection_run_id = <run>`, or drop the run row and let this FK cascade).
     * The binding is provenance: it proves the row came from one concrete run AT
     * THIS NAME+VERSION, and lets a read assert the active rows are from exactly
     * the run `active_run_id` names.
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
    uniqueIndex("entity_profiles_version_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.entityId,
    ),
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
    /** The named projection that produced this row — bound by the unique index + run FK below (see entity_profiles). */
    projectionName: text("projection_name").notNull(),
    projectionVersion: integer("projection_version").notNull(),
    /** The concrete replay run that produced this row — bound by the composite FK below (see entity_profiles). */
    projectionRunId: text("projection_run_id").notNull(),
    /** Stable endpoint nodes — both bound to the same user by the composite FKs below; never equal (self-edge check). */
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
      t.projectionName,
      t.projectionVersion,
      t.relationType,
      t.fromEntityId,
      t.toEntityId,
    ),
    // Include projectionName: a version integer is shared across named
    // projections (user_facts v1 and user-model v1 are both version 1), and
    // active-view reads filter by (name, version) — matching the unique index.
    index("entity_edges_from_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.fromEntityId,
    ),
    index("entity_edges_to_idx").on(t.userId, t.projectionName, t.projectionVersion, t.toEntityId),
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
    // No self-relation: a traversable typed edge from a node to itself
    // (`reports_to`/`frequent_collaborator`/… self) is meaningless and would let
    // recursive traversal ingest a 1-cycle. `entity_co_occurrence` gets this for
    // free from its `a < b` pair-order check; a directed edge needs it spelled out.
    check("entity_edges_no_self_relation", sql`${t.fromEntityId} <> ${t.toEntityId}`),
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
    /** The named projection that produced this row — bound by the unique index + run FK below (see entity_profiles). */
    projectionName: text("projection_name").notNull(),
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
      t.projectionName,
      t.projectionVersion,
      t.aEntityId,
      t.bEntityId,
    ),
    // projectionName included for the same reason as entity_edges' secondary
    // indexes: version collides across named projections; reads filter by name+version.
    index("entity_co_occurrence_weight_idx").on(
      t.userId,
      t.projectionName,
      t.projectionVersion,
      t.weight,
    ),
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
    check("projection_cursors_version_positive", sql`${t.projectionVersion} >= 1`),
    // Replay identity key — same non-empty floor as `projection_runs.projection_name`.
    check(
      "projection_cursors_name_nonempty",
      sql`length(${t.projectionName}) > 0 AND ${t.projectionName} = btrim(${t.projectionName})`,
    ),
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
    check("active_projection_versions_version_positive", sql`${t.activeVersion} >= 1`),
    // Replay identity key — same non-empty floor as `projection_runs.projection_name`.
    check(
      "active_projection_versions_name_nonempty",
      sql`length(${t.projectionName}) > 0 AND ${t.projectionName} = btrim(${t.projectionName})`,
    ),
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
    // No standalone (user_id, sync_slug) index — it is a left-prefix of the
    // unique `projection_sync_state_unique_idx` (user_id, sync_slug, stable_key),
    // which the planner uses for per-slug scans too.
    check("projection_sync_state_row_version_nonnegative", sql`${t.rowVersion} >= 0`),
    // `sync_slug` + `stable_key` are the Replicache sync identity (they feed
    // `projection_sync_state_unique_idx`), and `content_hash` is what the synthetic
    // `row_version` is derived from. An empty or whitespace-padded value collapses
    // unrelated sync rows into one slot or hashes distinct content to the same
    // version — the same merge-magnet floor as the other identity keys.
    check(
      "projection_sync_state_sync_slug_nonempty",
      sql`length(${t.syncSlug}) > 0 AND ${t.syncSlug} = btrim(${t.syncSlug})`,
    ),
    check(
      "projection_sync_state_stable_key_nonempty",
      sql`length(${t.stableKey}) > 0 AND ${t.stableKey} = btrim(${t.stableKey})`,
    ),
    check(
      "projection_sync_state_content_hash_nonempty",
      sql`length(${t.contentHash}) > 0 AND ${t.contentHash} = btrim(${t.contentHash})`,
    ),
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
