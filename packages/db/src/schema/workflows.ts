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

/** Breaks the type inference cycle between the two revision pointers. */
function workflowRevisionWorkflowIdentity(): [AnyPgColumn, AnyPgColumn] {
  return [workflowRevisions.workflowId, workflowRevisions.id];
}

/**
 * Workflows: a trigger, a brief, and optional steps (ADR-0017).
 * Built-ins live in TS and are seeded here on boot.
 * Runs live in `agent_runs`. There is no `workflow_runs` table.
 * The definition columns copy the published revision (#555). Only two writers may
 * change them: `automation/revisions.ts` for user rows, `automation/seeder.ts` for built-ins.
 * Code holds that split. No database constraint does.
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
    /** Matches `agent_runs.workflow_slug`. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    trigger: jsonb("trigger")
      .$type<WorkflowTrigger>()
      .notNull()
      .default(sql`'{"kind":"manual"}'::jsonb`),
    /** Null for built-ins. */
    brief: text("brief"),
    /** Null means one agent run on the brief. */
    steps: jsonb("steps").$type<WorkflowSteps>(),
    /** Step ids that need human approval. */
    hilGates: jsonb("hil_gates")
      .$type<WorkflowHilGates>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Upper bound on the integrations a run may load (ADR-0026). Empty means no limit. */
    allowedIntegrations: text("allowed_integrations")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Newest revision. Always null for built-ins. */
    currentRevisionId: text("current_revision_id"),
    /** The revision new runs pin. Moves only on activation, so edits do not touch scheduled runs. */
    publishedRevisionId: text("published_revision_id"),
    /** System block, such as a lost connection. Neither this nor `status` clears the other. */
    blocked: jsonb("blocked").$type<WorkflowBlocked>(),
    status: text("status").notNull().default("draft"),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    /** Copies for the settings list. */
    lastRunId: text("last_run_id"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    /** Next cron fire (ADR-0027). Null for non-cron and for cron rows not yet activated. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** Scheduled time of the last fire, not the time the run ended. */
    lastScheduledAt: timestamp("last_scheduled_at", { withTimezone: true }),
    /** Replicache version. Bump on every synced-field write, seeder included. */
    rowVersion: integer("row_version").notNull().default(1),
    ...lifecycle_dates,
  },
  (t) => [
    uniqueIndex("workflows_slug_idx").on(t.userId, t.slug),
    // FK target that makes a revision carry its workflow's user.
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
    index("workflows_active_idx")
      .on(t.userId, t.slug)
      .where(sql`${t.status} = 'active'`),
    // The cron tick scans due rows in `next_run_at` order (ADR-0027).
    index("workflows_next_run_at_idx")
      .on(t.nextRunAt)
      .where(sql`${t.status} = 'active' AND ${t.trigger}->>'kind' = 'cron'`),
  ],
);

/**
 * Immutable workflow definitions, one row per real edit (#555).
 * Only `approved_at` changes, on activation. Built-ins have no rows here.
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
    /** 1-based, no gaps per workflow. */
    revisionNumber: integer("revision_number").notNull(),
    /** Hash of the definition only, so a no-op edit adds no row. A proposal edit still adds one. */
    contentHash: text("content_hash").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    brief: text("brief").notNull(),
    trigger: jsonb("trigger").$type<WorkflowTrigger>().notNull(),
    /** Copied to `workflows` on publish. */
    allowedIntegrations: text("allowed_integrations")
      .array()
      .$type<IntegrationSlug[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** A run that proposes a tool outside this list gets `capability_mismatch`. */
    allowedTools: text("allowed_tools")
      .array()
      .$type<ToolName[]>()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    requiredCapabilities: jsonb("required_capabilities")
      .$type<WorkflowRequiredCapability[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Intent and assumptions for the activation card. Outside `content_hash` on purpose. */
    authoringProposal: jsonb("authoring_proposal").$type<WorkflowAuthoringProposal>(),
    /** Null for a direct user edit. */
    createdByRunId: text("created_by_run_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "workflow_revisions_workflow_owner_fk",
      columns: [t.workflowId, t.userId],
      foreignColumns: [workflows.id, workflows.userId],
    }).onDelete("cascade"),
    // FK targets for the workflow pointers and run attribution.
    uniqueIndex("workflow_revisions_workflow_id_idx").on(t.workflowId, t.id),
    uniqueIndex("workflow_revisions_id_user_idx").on(t.id, t.userId),
    // Two concurrent writers cannot claim the same number.
    uniqueIndex("workflow_revisions_number_idx").on(t.workflowId, t.revisionNumber),
    // A retried agent step reuses its row instead of adding a duplicate.
    uniqueIndex("workflow_revisions_run_idx")
      .on(t.workflowId, t.createdByRunId, t.contentHash)
      .where(sql`${t.createdByRunId} IS NOT NULL`),
  ],
);

export type Workflow = typeof workflows.$inferSelect;

export type NewWorkflow = typeof workflows.$inferInsert;

export type WorkflowRevision = typeof workflowRevisions.$inferSelect;

export type NewWorkflowRevision = typeof workflowRevisions.$inferInsert;
