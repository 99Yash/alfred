import {
  workflowHilGatesSchema,
  workflowStepSchema,
  workflowStepsSchema,
  workflowTriggerSchema,
  type WorkflowHilGates,
  type WorkflowStep,
  type WorkflowSteps,
  type WorkflowTrigger,
} from "@alfred/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, lifecycle_dates } from "../helpers";
import { user } from "./auth";

export { workflowHilGatesSchema, workflowStepSchema, workflowStepsSchema, workflowTriggerSchema };
export type { WorkflowHilGates, WorkflowStep, WorkflowSteps, WorkflowTrigger };

/**
 * Workflows (ADR-0017).
 *
 * A workflow is a `trigger + brief + optional steps DAG`. Two flavors live
 * in the same table:
 *
 *   - **Built-in**: code-as-workflow, source of truth in
 *     `apps/server/src/builtins/workflows/<slug>.ts`. Seeded into this
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
     * (ADR-0026 lazy-loading). The agent's initial `state.activeIntegrations`
     * is seeded from `@`-mentions parsed out of the brief; mid-run
     * `load_integration(slug)` calls grow that set, but cannot grow
     * past this list. Empty = unrestricted (subject to the user's
     * connected integrations).
     */
    allowedIntegrations: text("allowed_integrations")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
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

export type Workflow = typeof workflows.$inferSelect;
