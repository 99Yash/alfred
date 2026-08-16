import type {
  EffectOutcome,
  IntegrationRules,
  IntegrationSlug,
  JsonValue,
  PolicyMode,
  ToolName,
  ToolRiskTier,
} from "@alfred/contracts";
import type { ActionStagingStatus } from "@alfred/contracts";
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
    proposedInput: jsonb("proposed_input").$type<JsonValue>().notNull(),
    proposedInputHash: text("proposed_input_hash").notNull(),
    requiresApproval: boolean("requires_approval").notNull(),
    status: text("status").$type<ActionStagingStatus>().notNull().default("pending"),
    // #559a: the effect dimension, orthogonal to `status`. `status` is the
    // approval gate machine; `outcome` records what the effect itself did.
    // Minted with `planned` and advanced as the call moves through the gate and
    // the provider. `unknown` is the sticky possibly-delivered case — it holds
    // the ambiguity barrier (see the partial unique index below) and never
    // auto-retries.
    outcome: text("outcome").$type<EffectOutcome>().notNull().default("planned"),
    // #559a: one logical tool call keeps one `effect_key` across every retry and
    // reclaim; `attempt_key` rotates on each retry. `${runId}:${stepId}:${attempt}`
    // is NOT a safe downstream effect key — it changes on every reclaim.
    effectKey: text("effect_key").notNull(),
    attemptKey: text("attempt_key").notNull(),
    // #559a: canonical tool + args + target account/resource. The ambiguity
    // barrier keys on `(user_id, request_hash)`, so a fresh tool-call id cannot
    // bypass an unresolved possibly-delivered write.
    requestHash: text("request_hash").notNull(),
    // #559a: provider idempotency key. Equal to `effect_key` when the provider
    // supports idempotent writes, so a retry re-sends the same key and the
    // provider dedupes.
    providerKey: text("provider_key"),
    // #559a: the remote request/object/message id when the provider reports one.
    providerRef: text("provider_ref"),
    decidedInput: jsonb("decided_input").$type<JsonValue>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    executeResult: jsonb("execute_result").$type<JsonValue>(),
    // ADR-0070 §1.1: true when the dispatch-boundary sanitizer stripped
    // persistence-poison (NUL / lone surrogates) from `executeResult` before it
    // was stored. Persisted so an idempotent `executed` re-dispatch can hand the
    // model back the same "this result may be incomplete" notice it saw on the
    // first execution — otherwise the scrubbed payload replays as if pristine.
    executeSanitized: boolean("execute_sanitized").notNull().default(false),
    executeError: jsonb("execute_error").$type<JsonValue>(),
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
    // #559a: the ambiguity barrier. One unresolved `unknown` effect per
    // (user, request). A fresh model tool-call id for the same logical effect
    // collides here and is blocked until the effect is resolved or superseded.
    uniqueIndex("action_stagings_unknown_effect_idx")
      .on(t.userId, t.requestHash)
      .where(sql`${t.outcome} = 'unknown'`),
  ],
);

export type UserActionPolicy = typeof userActionPolicies.$inferSelect;
export type ActionStaging = typeof actionStagings.$inferSelect;
export type NewActionStaging = typeof actionStagings.$inferInsert;
