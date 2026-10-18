import { z } from "zod";
import { actionStagingStatusSchema, effectOutcomeSchema } from "./actions";
import {
  cronRunTriggerIdentitySchema,
  eventRunTriggerIdentitySchema,
  manualRunTriggerIdentitySchema,
  runStatusSchema,
  signalRunTriggerIdentitySchema,
  workflowRecoveryActionSchema,
  workflowRecoveryNavigationSchema,
} from "./agent";
import { enumGuard } from "./guards";
import { TOOL_UNAVAILABILITY_CODES } from "./integration-availability";
import { TOOL_RISK_TIERS } from "./tools";

/** Why a deferred run waits. `deferredRunOutcomeSchema.code` is one of these when this build wrote it. */
export const RUN_DEFER_REASONS = ["provider_unhealthy", "retry_scheduled"] as const;

export type RunDeferReason = (typeof RUN_DEFER_REASONS)[number];

export const isRunDeferReason = enumGuard(RUN_DEFER_REASONS);

/** Every code that the readiness check gives a problem (`workflowReadinessProblemSchema.code`). */
export const WORKFLOW_READINESS_PROBLEM_CODES = [
  ...TOOL_UNAVAILABILITY_CODES,
  "no_tool_surface",
  "choose_account",
  "resource_not_granted",
  /** The user must act (`connect`); the workflow blocks (#976). */
  "trigger_not_ready",
  /** Time or an operator fixes delivery (ADR-0097); the run defers. */
  "trigger_degraded",
] as const;

export type WorkflowReadinessProblemCode = (typeof WORKFLOW_READINESS_PROBLEM_CODES)[number];

/**
 * `blockedRunOutcomeSchema.code` when this build wrote it: the first readiness problem's code,
 * or `blocked` when the run output names none.
 */
export const BLOCKED_RUN_CODES = [...WORKFLOW_READINESS_PROBLEM_CODES, "blocked"] as const;

export const isBlockedRunCode = enumGuard(BLOCKED_RUN_CODES);

/**
 * Persisted on a blocked run. `code` stays an open string so a retired code still parses; a
 * reader narrows it with `isBlockedRunCode` or `WORKFLOW_READINESS_PROBLEM_CODES`.
 */
export const workflowReadinessProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string(),
  /** Omitted when no user action can fix it. */
  recoveryAction: workflowRecoveryActionSchema.optional(),
});

export type PersistedWorkflowReadinessProblem = z.infer<typeof workflowReadinessProblemSchema>;

export const workflowReadinessOutputSchema = z.object({
  readiness: z.array(workflowReadinessProblemSchema),
});

/** One attempted external write, from `action_stagings`. Reads never appear. */
export const effectReceiptSchema = z.object({
  effectKey: z.string(),
  toolName: z.string(),
  integration: z.string(),
  riskTier: z.enum(TOOL_RISK_TIERS),
  outcome: effectOutcomeSchema,
  status: actionStagingStatusSchema,
  providerRef: z.string().nullable(),
  executedAt: z.string().nullable(),
});

export type EffectReceipt = z.infer<typeof effectReceiptSchema>;

/**
 * `agent_runs.outcome` for a workflow run, read by the history view.
 * Chat turns and sub-agents never set one.
 */
const completedRunOutcomeSchema = z.object({
  kind: z.literal("completed"),
  summary: z.string(),
  effects: z.array(effectReceiptSchema).max(50),
});

const noChangeRunOutcomeSchema = z.object({ kind: z.literal("no_change"), summary: z.string() });

const deferredRunOutcomeSchema = z.object({
  kind: z.literal("deferred"),
  code: z.string(),
  retryAt: z.string().optional(),
});

const blockedRunOutcomeSchema = z.object({
  kind: z.literal("blocked"),
  code: z.string(),
  recovery: z.array(workflowRecoveryActionSchema),
});

const failedRunOutcomeSchema = z.object({
  kind: z.literal("failed"),
  code: z.string(),
  safeMessage: z.string(),
});

const cancelledRunOutcomeSchema = z.object({
  kind: z.literal("cancelled"),
  completedEffects: z.array(effectReceiptSchema).max(50),
  unknownEffects: z.array(z.string()),
});

/** A write reached the provider with no observed result. Never offer a retry: it could duplicate. */
const unknownWriteRunOutcomeSchema = z.object({
  kind: z.literal("unknown_write_outcome"),
  effectKey: z.string(),
  safeToRetry: z.literal(false),
});

export const workflowRunOutcomeSchema = z.discriminatedUnion("kind", [
  completedRunOutcomeSchema,
  noChangeRunOutcomeSchema,
  deferredRunOutcomeSchema,
  blockedRunOutcomeSchema,
  failedRunOutcomeSchema,
  cancelledRunOutcomeSchema,
  unknownWriteRunOutcomeSchema,
]);

export type WorkflowRunOutcome = z.infer<typeof workflowRunOutcomeSchema>;

/**
 * The outcome without its receipt lists. The approval route refuses a finished run,
 * so the row's live `effects` list is the same and the wire sends it once.
 */
export const workflowRunHistoryOutcomeSchema = z.discriminatedUnion("kind", [
  completedRunOutcomeSchema.omit({ effects: true }),
  noChangeRunOutcomeSchema,
  deferredRunOutcomeSchema,
  blockedRunOutcomeSchema,
  failedRunOutcomeSchema,
  cancelledRunOutcomeSchema.omit({ completedEffects: true }),
  unknownWriteRunOutcomeSchema,
]);

export type WorkflowRunHistoryOutcome = z.infer<typeof workflowRunHistoryOutcomeSchema>;

export const workflowRunRecoverySchema = z.discriminatedUnion("kind", [
  workflowRecoveryNavigationSchema,
  /** Recheck readiness on the pinned revision. */
  z.object({ kind: z.literal("recheck"), revisionId: z.string() }),
  /** New run, same trigger, chosen revision. */
  z.object({
    kind: z.literal("run_again"),
    revisionChoice: z.enum(["original", "latest"]),
  }),
  /** Nothing to do, but the effect list is worth a look. */
  z.object({ kind: z.literal("inspect") }),
  z.object({ kind: z.literal("none") }),
]);

export type WorkflowRunRecovery = z.infer<typeof workflowRunRecoverySchema>;

/** `agentRunTriggerSchema` identity variants without the event payload. */
export const workflowRunHistoryTriggerSchema = z.discriminatedUnion("kind", [
  cronRunTriggerIdentitySchema,
  eventRunTriggerIdentitySchema,
  manualRunTriggerIdentitySchema,
  signalRunTriggerIdentitySchema,
]);

export type WorkflowRunHistoryTrigger = z.infer<typeof workflowRunHistoryTriggerSchema>;

export const workflowRunHistoryRowSchema = z.object({
  id: z.string(),
  occurrenceKey: z.string().nullable(),
  replayOfRunId: z.string().nullable(),
  trigger: workflowRunHistoryTriggerSchema.nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  revisionId: z.string().nullable(),
  revisionNumber: z.number().nullable(),
  isCurrent: z.boolean(),
  isPublished: z.boolean(),
  status: runStatusSchema,
  outcome: workflowRunHistoryOutcomeSchema.nullable(),
  /** Oldest first. */
  effects: z.array(effectReceiptSchema).max(50),
  effectsTruncated: z.boolean(),
  /** Empty unless the run blocked. */
  coverageGaps: z.array(workflowReadinessProblemSchema),
  recovery: workflowRunRecoverySchema,
});

export type WorkflowRunHistoryRow = z.infer<typeof workflowRunHistoryRowSchema>;

/** Newest first. */
export const workflowRunHistorySchema = z.object({
  items: z.array(workflowRunHistoryRowSchema).max(50),
  nextCursor: z.string().nullable(),
});

export type WorkflowRunHistory = z.infer<typeof workflowRunHistorySchema>;
