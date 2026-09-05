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
import { TOOL_RISK_TIERS } from "./tools";

/**
 * One readiness problem as it is persisted on a blocked run's `output`. The
 * runtime narrows `code` to its own closed union; a persisted row keeps the
 * open string so an old code still parses after the runtime forgets it.
 */
export const workflowReadinessProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string(),
  /** Omitted when no user action can truthfully make the capability runnable. */
  recoveryAction: workflowRecoveryActionSchema.optional(),
});
export type PersistedWorkflowReadinessProblem = z.infer<typeof workflowReadinessProblemSchema>;

/** The `output` shape the `check-readiness` step writes when a run blocks. */
export const workflowReadinessOutputSchema = z.object({
  readiness: z.array(workflowReadinessProblemSchema),
});

/**
 * One external write the run attempted, projected from its `action_stagings`
 * row. Reads are never receipts: only write tiers appear here.
 */
export const effectReceiptSchema = z.object({
  effectKey: z.string(),
  toolName: z.string(),
  integration: z.string(),
  riskTier: z.enum(TOOL_RISK_TIERS),
  outcome: effectOutcomeSchema,
  status: actionStagingStatusSchema,
  providerRef: z.string().nullable(),
  /** ISO-8601 instant the effect executed, or null when it never did. */
  executedAt: z.string().nullable(),
});
export type EffectReceipt = z.infer<typeof effectReceiptSchema>;

/**
 * The typed verdict written on `agent_runs.outcome` when a workflow run ends
 * (or defers). The history surface reads this instead of the raw `status` and
 * `error` columns, so every kind carries only what the user needs to decide
 * whether anything happened and what to do next. Internal runs (chat turns,
 * sub-agents) never carry an outcome.
 */
const completedRunOutcomeSchema = z.object({
  kind: z.literal("completed"),
  summary: z.string(),
  effects: z.array(effectReceiptSchema).max(50),
});
/** The run finished with no successful external write. */
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
/**
 * At least one write reached the provider and its result was never
 * observed. A retry could duplicate the effect, so this kind never offers one.
 */
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
 * The outcome as the history wire carries it: the persisted verdict minus its
 * frozen receipt lists. No effect can land after the terminal write (the
 * approval route refuses a finished run), so the live ledger on the row is the
 * same list and the wire ships it once. Counts the client shows for a
 * cancelled run come from that live ledger.
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

/** The single recovery the history surface offers for one run. */
export const workflowRunRecoverySchema = z.discriminatedUnion("kind", [
  workflowRecoveryNavigationSchema,
  /** Re-run the readiness check against the revision the run pinned. */
  z.object({ kind: z.literal("recheck"), revisionId: z.string() }),
  /** Start a new run from the same trigger with the chosen revision. */
  z.object({
    kind: z.literal("run_again"),
    revisionChoice: z.enum(["original", "latest"]),
  }),
  /** Nothing to do, but the effect list is worth a look. */
  z.object({ kind: z.literal("inspect") }),
  z.object({ kind: z.literal("none") }),
]);
export type WorkflowRunRecovery = z.infer<typeof workflowRunRecoverySchema>;

/**
 * The trigger as the history surface shows it: the identity variants that
 * `agentRunTriggerSchema` is built from, without the event payload. Only the
 * exact identity of the firing (schedule instant, event id, signal name)
 * survives the projection.
 */
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
  /** The run pinned the workflow's current revision. */
  isCurrent: z.boolean(),
  /** The run pinned the workflow's published revision. */
  isPublished: z.boolean(),
  status: runStatusSchema,
  outcome: workflowRunHistoryOutcomeSchema.nullable(),
  /** Write-tier stagings for the run, oldest first, capped at 50. */
  effects: z.array(effectReceiptSchema).max(50),
  effectsTruncated: z.boolean(),
  /** Readiness problems a blocked run recorded; empty for every other status. */
  coverageGaps: z.array(workflowReadinessProblemSchema),
  recovery: workflowRunRecoverySchema,
});
export type WorkflowRunHistoryRow = z.infer<typeof workflowRunHistoryRowSchema>;

/** One keyset page of a workflow's runs, newest first. */
export const workflowRunHistorySchema = z.object({
  items: z.array(workflowRunHistoryRowSchema).max(50),
  nextCursor: z.string().nullable(),
});
export type WorkflowRunHistory = z.infer<typeof workflowRunHistorySchema>;
