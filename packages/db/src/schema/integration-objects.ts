import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";
import { entities } from "./memory";

/**
 * Integration object-state memory (ADR-0062, #212).
 *
 * A deterministic, registry-driven projection of the lifecycle state of
 * external *work objects* — GitHub PRs today, ClickUp tasks / remote Claude
 * runs later. The deterministic sibling of the semantic user-memory in
 * `memory.ts` (ADR-0057): the same temporal + graph machinery, with the
 * fuzzy/vector/LLM half deliberately omitted from the closure path. State is
 * asserted ONLY by the per-provider webhook reducer over `webhook_events`;
 * an LLM may *propose* a candidate key (a `head_sha`) but never *assert*
 * state, so a hallucinated key resolves to nothing and cannot fake a merge
 * (the propose/dispose invariant that keeps ADR-0048's closure contract intact).
 *
 *   integration_objects           identity + normalized state, bitemporal
 *   integration_object_keys       sidecar key index (head_sha → PR, branch → PR)
 *   integration_object_relations  object↔entity edges (authored_by, in_project, closes)
 *
 * Why a materialized projection and not a gather-time recompute: a briefing
 * loop spans a PR's whole event history (the failure email and the merge
 * webhook are both days old), but `gather` reads a 24h/cap-25 window — it
 * structurally cannot see the closure. The projection is required, not
 * optional, at dozen-user scale with months of webhook history.
 *
 * `state_category`, `kind`, `key_kind`, `relation` are `text` (not pg enums)
 * for the same migration-ergonomics reason as the rest of the schema — the
 * `@alfred/contracts` registry validates the legal values at the app boundary.
 */

// ---------------------------------------------------------------------------
// integration_objects
// ---------------------------------------------------------------------------

/**
 * One row per external work object, keyed by its provider-native identity
 * `(user_id, provider, kind, external_id)`. Carries both the provider-agnostic
 * `state_category` (what generic consumers like briefing reconciliation read)
 * and the `native_state` (retained for display + audit fidelity).
 *
 * Own bitemporal columns (`valid_from`/`valid_until`/`supersedes_id`) mirror
 * `user_facts` — point-in-time `getState(ref, at?)` and supersession for free —
 * but state is written by the deterministic reducer, NOT routed through
 * `proposeFact` (which is LLM/confidence-gated and wrong for deterministic
 * external state).
 */
export const integrationObjects = pgTable(
  "integration_objects",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobj")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Integration slug — `github`, later `clickup`, `claude-code`. */
    provider: text("provider").notNull(),
    /** Object kind within the provider — `pull_request` (v1). */
    kind: text("kind").notNull(),
    /** Provider-native stable id — the PR number as a string for github. */
    externalId: text("external_id").notNull(),
    /** Provider-agnostic bucket — `active | resolved | failed | abandoned`. */
    stateCategory: text("state_category").notNull(),
    /** Raw provider state for display/audit — `open`/`merged`/`closed`/… */
    nativeState: text("native_state"),
    title: text("title"),
    url: text("url"),
    /** `owner/repo` for github; provider-specific locator otherwise. */
    repo: text("repo"),
    /** Free-form bag — head_sha, base/head ref, author login, … */
    attributes: jsonb("attributes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Last delivery that advanced this object's state. Transitions are guarded
     * by this timestamp so a redelivered or out-of-order webhook never regresses
     * state (the reducer's monotonicity guarantee).
     */
    stateDeliveredAt: timestamp("state_delivered_at", { withTimezone: true }),
    /** Temporal validity window (ADR-0012 machinery; see `user_facts`). */
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    /** Self-reference: this row replaces `supersedes_id`. */
    supersedesId: text("supersedes_id"),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_objects_identity_idx").on(
      t.userId,
      t.provider,
      t.kind,
      t.externalId,
    ),
    index("integration_objects_kind_idx").on(t.userId, t.provider, t.kind),
    index("integration_objects_state_idx").on(t.userId, t.stateCategory),
  ],
);

// ---------------------------------------------------------------------------
// integration_object_keys
// ---------------------------------------------------------------------------

/**
 * Sidecar key index: `(user_id, provider, key_kind, key_value) → object_id`.
 * `head_sha → PR`, `branch → PR`, `run_id → PR`, `task_id → task` all resolve
 * uniformly. The `head_sha → PR` lookup is the exact thing prod recon proved
 * necessary — a GitHub CI email carries a head-sha and *no* PR number, so the
 * loop can only close by resolving the sha back to its PR.
 */
export const integrationObjectKeys = pgTable(
  "integration_object_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobjk")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => integrationObjects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** Key kind within the provider — `head_sha`, `branch` (v1 github). */
    keyKind: text("key_kind").notNull(),
    keyValue: text("key_value").notNull(),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_object_keys_unique_idx").on(
      t.userId,
      t.provider,
      t.keyKind,
      t.keyValue,
    ),
    index("integration_object_keys_object_idx").on(t.objectId),
  ],
);

// ---------------------------------------------------------------------------
// integration_object_relations
// ---------------------------------------------------------------------------

/**
 * Object↔entity edges (`authored_by`, `in_project`, `closes`), mirroring
 * `entity_relations`' shape so graph traversal stays uniform (the same
 * recursive-CTE style).
 *
 * Deliberately DISTINCT from `entity_relations` (entity↔entity): objects are
 * high-churn and must NOT become `entities` rows — that would pollute the
 * canonical-name-indexed people/org table. A dedicated edge table gives the
 * graph goodies (traversal, cross-source dedup) without that overload.
 */
export const integrationObjectRelations = pgTable(
  "integration_object_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("iobjr")),
    /** Denormalized so traversal queries can filter without an extra join. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => integrationObjects.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** authored_by | in_project | closes | … */
    relation: text("relation").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("integration_object_relations_unique_idx").on(
      t.userId,
      t.objectId,
      t.entityId,
      t.relation,
    ),
    index("integration_object_relations_object_idx").on(t.userId, t.objectId),
    index("integration_object_relations_entity_idx").on(t.userId, t.entityId),
  ],
);

export type IntegrationObject = typeof integrationObjects.$inferSelect;
export type NewIntegrationObject = typeof integrationObjects.$inferInsert;
export type IntegrationObjectKey = typeof integrationObjectKeys.$inferSelect;
export type IntegrationObjectRelation = typeof integrationObjectRelations.$inferSelect;
