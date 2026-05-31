import type {
  IntegrationRules,
  IntegrationSlug,
  PolicyMode,
  ToolName,
  ToolRiskTier,
} from "@alfred/contracts";
import type { ActionStagingStatus } from "@alfred/schemas";
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
import { createId } from "../helpers";
import { agentRuns } from "./agent";
import { user } from "./auth";

export const userActionPolicies = pgTable("user_action_policies", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultMode: text("default_mode").$type<PolicyMode>().notNull().default("gated"),
  integrationRules: jsonb("integration_rules")
    .$type<IntegrationRules>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  approvalNotifyDelayMs: integer("approval_notify_delay_ms").notNull().default(300_000),
  // Replicache CVR version for the per-integration policy editor (m13 Phase
  // 8c). The whole row is one synced entity keyed by `user_id`; every policy
  // mutation bumps this so the client pull patches, and *also* publishes
  // `policy-bust:u:<userId>` for the dispatcher's in-process cache. Two
  // invalidation paths, one mutation (ADR-0034 amendment).
  rowVersion: integer("row_version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const actionStagings = pgTable(
  "action_stagings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId("as")),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").$type<ToolName>().notNull(),
    integration: text("integration").$type<IntegrationSlug>().notNull(),
    riskTier: text("risk_tier").$type<ToolRiskTier>().notNull(),
    proposedInput: jsonb("proposed_input").notNull(),
    proposedInputHash: text("proposed_input_hash").notNull(),
    requiresApproval: boolean("requires_approval").notNull(),
    status: text("status").$type<ActionStagingStatus>().notNull().default("pending"),
    decidedInput: jsonb("decided_input"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executeResult: jsonb("execute_result"),
    executeError: jsonb("execute_error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    notifyAfterAt: timestamp("notify_after_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    rowVersion: integer("row_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("action_stagings_run_tool_call_idx").on(t.runId, t.toolCallId),
    index("action_stagings_pending_user_idx")
      .on(t.userId, t.status)
      .where(sql`${t.status} = 'pending'`),
    index("action_stagings_run_idx").on(t.runId),
    index("action_stagings_rejected_retry_idx")
      .on(t.runId, t.toolName, t.proposedInputHash)
      .where(sql`${t.status} = 'rejected'`),
    index("action_stagings_recent_rejections_idx")
      .on(t.userId, t.toolName, t.decidedAt.desc())
      .where(sql`${t.status} = 'rejected'`),
  ],
);
