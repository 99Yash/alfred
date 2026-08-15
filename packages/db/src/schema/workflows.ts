import {
  workflowAuthoringProposalSchema,
  workflowBlockedSchema,
  workflowHilGatesSchema,
  workflowRequiredCapabilitySchema,
  workflowRevisionDefinitionSchema,
  workflowStepSchema,
  workflowStepsSchema,
  workflowTriggerSchema,
  type IntegrationSlug,
  type ToolName,
  type WorkflowAuthoringProposal,
  type WorkflowBlocked,
  type WorkflowHilGates,
  type WorkflowRequiredCapability,
  type WorkflowRevisionDefinition,
  type WorkflowStep,
  type WorkflowSteps,
  type WorkflowTrigger,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

export {
  workflowAuthoringProposalSchema,
  workflowBlockedSchema,
  workflowHilGatesSchema,
  workflowRequiredCapabilitySchema,
  workflowRevisionDefinitionSchema,
  workflowStepSchema,
  workflowStepsSchema,
  workflowTriggerSchema,
};
export type {
  WorkflowAuthoringProposal,
  WorkflowBlocked,
  WorkflowHilGates,
  WorkflowRequiredCapability,
  WorkflowRevisionDefinition,
  WorkflowStep,
  WorkflowSteps,
  WorkflowTrigger,
};

/**
 * Break the TypeScript inference cycle created by the two revision pointers.
 * Drizzle evaluates the extra-config callback after both tables exist; the
 * explicit column tuple keeps each table's inferred row type independent.
 */
function workflowRevisionWorkflowIdentity(): [AnyPgColumn, AnyPgColumn] {
  return [workflowRevisions.workflowId, workflowRevisions.id];
}

/**
 * Workflows (ADR-0017).
 *
 * A workflow is a `trigger + brief + optional steps DAG`. Two flavors live
 * in the same table:
 *
 *   - **Built-in**: code-as-workflow, source of truth in the TS recipe
 *     that owns the domain — for example
 *     `packages/assistant/src/triage/email-triage.ts` — registered at boot
 *     from `apps/server/src/builtins/index.ts`. Seeded into this
 *     table at deploy time so the settings UI can render them alongside
 *     user-authored ones with the same toggle UX. `is_builtin = true`,
 *     `brief = null`, `steps = null` (the TS module owns step definitions
 *     and `initialState`).
 *
 *   - **User-authored**: `is_builtin = false`. Brief-only or brief+steps
 *     per ADR-0017. Brief-only fans into a single AlfredAgent run that
 *     decomposes at runtime; explicit-steps runs deterministically.
 *
 * `agent_runs` is the runtime-state table — `agent_runs.workflow_slug`
 * joins back here. We do NOT keep a separate `workflow_runs` table:
 * `agent_runs` already has status + started_at + ended_at + cost
 * attribution via `api_call_log`. Querying for a workflow's runs is
 * `SELECT … FROM agent_runs WHERE user_id = ? AND workflow_slug = ?`.
 *
 * **The definition columns are a denormalized copy (#555).** `name`,
 * `description`, `brief`, `trigger` and `allowed_integrations` mirror the
 * *published* revision — or the current one while `published_revision_id` is
 * still null. They stay on this row because `trigger` backs the partial index
 * the per-minute tick scans, and because the settings list and the Replicache
 * read model want one row, not a join. The price of the copy is that it can
 * drift, so exactly two writers are allowed, and they split by `is_builtin`.
 * The revision service in `packages/assistant/src/automation/revisions.ts`
 * owns user-authored rows: every path of it that reaches a definition column
 * returns `builtin_immutable` first. The seeder in
 * `packages/assistant/src/automation/seeder.ts` owns builtin rows, which it
 * re-seeds on every boot. Nothing else may `UPDATE workflows SET trigger = …`.
 *
 * **That split is a convention, not a constraint.** TypeScript guards and slug
 * allocation hold the two writers apart. Nothing in this schema does:
 * `workflows_slug_idx` is a plain unique index on `(user_id, slug)`, and no
 * partial index, CHECK, or predicate stops either writer from reaching the
 * other's rows. Do not read `is_builtin` here as a boundary the database
 * upholds.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("wf")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Stable slug; matches `agent_runs.workflow_slug`. Unique per user. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Trigger spec. Discriminated by `kind`:
     *   { kind: 'cron', schedule: '0 7 * * *', timezone?: 'America/New_York' }
     *   { kind: 'event', source: 'gmail', filter?: { … } }
     *   { kind: 'manual' }
     *   { kind: 'on_signal', name: 'cold-start.ready' }
     * Trigger-side dispatchers consult `status='active'` before enqueuing.
     */
    trigger: jsonb("trigger")
      .$type<WorkflowTrigger>()
      .notNull()
      .default(sql`'{"kind":"manual"}'::jsonb`),
    /**
     * Natural-language brief for user-authored workflows. Built-ins keep
     * this null and rely on their TS module's step definitions.
     */
    brief: text("brief"),
    /**
     * Optional explicit DAG. When non-null, the runtime executes
     * deterministically; node types per ADR-0017 (`run_skill`,
     * `tool_call`, `llm_call`, `agent_run`, `condition`, `parallel`,
     * `loop`, `hil_approve`). Null = brief-only agent run.
     */
    steps: jsonb("steps").$type<WorkflowSteps>(),
    /**
     * Step ids that require HIL approval. Only meaningful with explicit
     * `steps`. Shape: `string[]`.
     */
    hilGates: jsonb("hil_gates")
      .$type<WorkflowHilGates>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Bound on which integrations the workflow's agent runs may load
     * (ADR-0026 lazy-loading, amended by #407). The agent's exact `state.activeTools`
     * is seeded from `@`-mentions parsed out of the brief; mid-run exact-tool
     * deterministic preload and exact `load_tool(name)` calls grow that set,
     * but cannot grow past this list. Empty = unrestricted (subject to the user's
     * connected integrations).
     */
    allowedIntegrations: text("allowed_integrations")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /**
     * Newest revision (#555). Null for built-ins, which own their definition in
     * a TS module and never mint a revision row.
     */
    currentRevisionId: text("current_revision_id"),
    /**
     * The revision new occurrences pin. Advances only on activation, which is
     * why editing an active workflow does not disturb what is scheduled: the
     * tick reads this pointer, not `current_revision_id`. Null until the first
     * activation, and always null for built-ins.
     */
    publishedRevisionId: text("published_revision_id"),
    /**
     * Operational readiness, deliberately separate from `status` (#555). A
     * missing connection or a dead watch writes here; the user's pause writes
     * `status`. Writing one must never clear the other. Shape:
     * `workflowBlockedSchema`.
     */
    blocked: jsonb("blocked").$type<WorkflowBlocked>(),
    /** active | draft | paused | archived. Settings toggle flips active ↔ paused. */
    status: text("status").notNull().default("draft"),
    /** True for alfred-curated workflows seeded from the repo. */
    isBuiltin: boolean("is_builtin").notNull().default(false),
    /** Last execution shortcuts — denormalized for cheap settings-page reads. */
    lastRunId: text("last_run_id"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    /**
     * Cron dispatch denormalization (ADR-0027). Recomputed via `cron-parser`
     * at exactly two write moments: (i) after a `workflows` write that
     * mutates `trigger` or flips `status` to `active`, (ii) inside
     * `workflows.tick` right after a successful fire. Null for non-cron
     * triggers and for paused/draft cron workflows that haven't been
     * primed yet.
     */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /**
     * The `scheduledFor` instant of the most recent fire — distinct from
     * `last_run_at` (wall-clock end of the run). Useful to detect tick
     * delays (`last_run_at - last_scheduled_at`) and to seed the next
     * `cron-parser.next()` call.
     */
    lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
    /**
     * Replicache CVR version. Bumped on every synced-field write (the
     * authoring editor's `workflowUpdate` mutator) so pull diffing patches
     * the client. Seeder writes leave it at the default — built-ins re-seed
     * idempotently and the editor only touches user-authored rows.
     */
    rowVersion: integer("row_version").notNull().default(1),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("workflows_slug_idx").on(t.userId, t.slug),
    // Composite target for revision ownership. `id` is already globally
    // unique; this second key lets Postgres enforce that a revision carries
    // the same user as its workflow.
    uniqueIndex("workflows_id_user_idx").on(t.id, t.userId),
    foreignKey({
      name: "workflows_current_revision_fk",
      columns: [t.id, t.currentRevisionId],
      foreignColumns: workflowRevisionWorkflowIdentity(),
    }),
    foreignKey({
      name: "workflows_published_revision_fk",
      columns: [t.id, t.publishedRevisionId],
      foreignColumns: workflowRevisionWorkflowIdentity(),
    }),
    index("workflows_user_status_idx").on(t.userId, t.status, t.updatedAt),
    // The cron tick / event dispatcher only cares about active rows; this
    // partial index keeps the scan tight as paused/draft rows accumulate.
    index("workflows_active_idx")
      .on(t.userId, t.slug)
      .where(sql`${t.status} = 'active'`),
    // ADR-0027: tick query is `WHERE next_run_at <= now() ORDER BY
    // next_run_at LIMIT 100` over the active cron set. Partial keeps the
    // index tight; the status + trigger.kind filters land in the WHERE
    // clause so non-cron and paused rows never touch the index.
    index("workflows_next_run_at_idx")
      .on(t.nextRunAt)
      .where(sql`${t.status} = 'active' AND ${t.trigger}->>'kind' = 'cron'`),
  ],
);

/**
 * Immutable workflow definitions (#555).
 *
 * One row per semantic edit. Rows are never updated in place — the only
 * mutable column is `approved_at`, which activation stamps on the row it
 * publishes. `workflows.current_revision_id` advances on every edit;
 * `workflows.published_revision_id` advances only on activation. A run pins
 * whichever revision was published when its occurrence was claimed
 * (`agent_runs.workflow_revision_id`) and keeps executing that definition even
 * after the user edits the workflow.
 *
 * `content_hash` is `workflowRevisionContentHash` over the definition fields
 * only (`workflowRevisionDefinitionSchema`), so an edit that changes nothing
 * semantic — such as a reordered tool list — re-hashes to the same value and
 * appends no row. Proposal-only edits, including assumptions, append a row so
 * the reviewed explanation stays attributable.
 *
 * Built-ins never appear here. Their definition lives in the domain-owned TS
 * recipe registered from `apps/server/src/builtins/index.ts`, so seeding one
 * mints no revision and both pointers stay null.
 */
export const workflowRevisions = pgTable(
  "workflow_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("wfr")),
    workflowId: text("workflow_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** 1-based, dense per workflow. The user-facing "v3" on the History tab. */
    revisionNumber: integer("revision_number").notNull(),
    /** `sha256:…` over the canonical definition. See the file header. */
    contentHash: text("content_hash").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    brief: text("brief").notNull(),
    trigger: jsonb("trigger").$type<WorkflowTrigger>().notNull(),
    /** Coarse dispatcher backstop; copied to `workflows` on publish. */
    allowedIntegrations: text("allowed_integrations")
      .array()
      .$type<IntegrationSlug[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /**
     * The exact execution envelope (#557 fills it). A run that proposes a tool
     * outside this list gets `capability_mismatch` — an unattended workflow is
     * never silently widened.
     */
    allowedTools: text("allowed_tools")
      .array()
      .$type<ToolName[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Shape: `workflowRequiredCapabilitySchema[]`. Read by `check-readiness` (#558). */
    requiredCapabilities: jsonb("required_capabilities")
      .$type<WorkflowRequiredCapability[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Original intent and assumptions for the activation card (#556). Shape:
     * `workflowAuthoringProposalSchema`. Outside `content_hash` on purpose.
     */
    authoringProposal: jsonb("authoring_proposal").$type<WorkflowAuthoringProposal>(),
    /** The `agent_runs.id` that authored this revision. Null for a direct user edit. */
    createdByRunId: text("created_by_run_id"),
    /** Set when this revision becomes the published one. Null while it is a draft. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "workflow_revisions_workflow_owner_fk",
      columns: [t.workflowId, t.userId],
      foreignColumns: [workflows.id, workflows.userId],
    }).onDelete("cascade"),
    // Composite targets used by the workflow pointers and run attribution.
    uniqueIndex("workflow_revisions_workflow_id_idx").on(t.workflowId, t.id),
    uniqueIndex("workflow_revisions_id_user_idx").on(t.id, t.userId),
    // Dense numbering under concurrency: the second writer to claim the same
    // number hits a 23505 and retries against the row the first one committed.
    uniqueIndex("workflow_revisions_number_idx").on(t.workflowId, t.revisionNumber),
    // Idempotency guard, same shape as `skill_revisions_run_idx`: an
    // agent-produced revision is unique per (workflow, producing run), so a
    // step retry that re-enters the commit collapses onto the existing row
    // instead of appending a duplicate. Partial on a non-null run id — a direct
    // user edit carries none and may save many times.
    uniqueIndex("workflow_revisions_run_idx")
      .on(t.workflowId, t.createdByRunId, t.contentHash)
      .where(sql`${t.createdByRunId} IS NOT NULL`),
  ],
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRevision = typeof workflowRevisions.$inferSelect;
export type NewWorkflowRevision = typeof workflowRevisions.$inferInsert;
