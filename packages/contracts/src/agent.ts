import { z } from "zod";
import { integrationSlugSchema, isIanaTimezone } from "./briefing";
import { EVENT_SOURCES } from "./event-triggers";
import { toolNameSchema } from "./tools";
import { jsonObjectSchema } from "./user-model";

/**
 * Lifecycle status of an `agent_runs` row.
 *
 * **Member order is load-bearing — append, never reorder.** `TERMINAL_RUN_STATUSES`
 * below preserves this order, and `runIsNotTerminal` (`@alfred/db`) renders it
 * into the `status NOT IN (…)` predicate of three partial unique indexes.
 * drizzle-kit diffs a partial index by its predicate *text*, so permuting this
 * enum regenerates all three as DROP/CREATE — brief windows in a migration
 * where the race-safe boundaries of #488 and #531 do not exist.
 */
export const runStatusSchema = z.enum([
  "pending",
  "runnable",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export const RUN_STATUSES = Object.freeze([...runStatusSchema.options]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Does a status end a run? Declared as data and checked exhaustively: a new
 * member of `runStatusSchema` without an entry here is a build error. A
 * hand-written `s === "completed" || …` chain answers `false` for the new
 * member instead — silently, everywhere at once, including the executor's
 * commit guard and every `NOT IN` predicate derived below.
 */
const RUN_STATUS_KIND = {
  pending: "live",
  runnable: "live",
  running: "live",
  waiting: "live",
  completed: "terminal",
  failed: "terminal",
  cancelled: "terminal",
} as const satisfies Record<RunStatus, "live" | "terminal">;

export function isTerminalStatus(s: RunStatus): boolean {
  return RUN_STATUS_KIND[s] === "terminal";
}

/**
 * The terminal statuses as data, for SQL that has to name them rather than call
 * {@link isTerminalStatus} per row. Both come from {@link RUN_STATUS_KIND}, so
 * they cannot disagree. SQL callers should reach for `runIsNotTerminal` from
 * `@alfred/db` rather than interpolating this list themselves — the whole point
 * is that the predicate exists once.
 *
 * Order follows {@link runStatusSchema}'s declaration order, which is why that
 * order may not be permuted: this list's order is what the partial-index
 * predicates are diffed on. See the note there.
 */
export const TERMINAL_RUN_STATUSES = Object.freeze(RUN_STATUSES.filter(isTerminalStatus));

export const approvalKindSchema = z.enum(["step", "action_staging"]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const wakeConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hil"),
    approvalId: z.string(),
    approvalKind: approvalKindSchema.optional(),
    prompt: z.string().optional(),
  }),
  z.object({ kind: z.literal("timer"), wakeAt: z.string() }),
  z.object({ kind: z.literal("signal"), name: z.string() }),
]);
export type WakeCondition = z.infer<typeof wakeConditionSchema>;

export const agentRunTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    scheduledFor: z.string(),
  }),
  z.object({
    kind: z.literal("event"),
    // Optional for tolerant reads of historical event runs written before
    // ADR-0047 promoted source/type to first-class trigger fields.
    source: z.string().optional(),
    type: z.string().optional(),
    eventId: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("on_signal"), signalName: z.string() }),
]);
export type AgentRunTrigger = z.infer<typeof agentRunTriggerSchema>;

export const cronWorkflowTriggerSchema = z.object({
  kind: z.literal("cron"),
  schedule: z.string(),
  timezone: z.string().optional(),
});
export const eventWorkflowTriggerSchema = z.object({
  kind: z.literal("event"),
  // Closed enums per ADR-0047; `type` is required on writes so the
  // `emitEvent` query (`trigger->>'source' = … AND trigger->>'type' = …`)
  // can match. Per-source type validity is enforced in `emitEvent`.
  source: z.enum(EVENT_SOURCES),
  type: z.string(),
  /** Durable provider account identity for user-authored external events. */
  accountRef: z.string().min(1).max(200).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export const manualWorkflowTriggerSchema = z.object({ kind: z.literal("manual") });
export const signalWorkflowTriggerSchema = z.object({
  kind: z.literal("on_signal"),
  name: z.string(),
});

export const workflowTriggerSchema = z.discriminatedUnion("kind", [
  cronWorkflowTriggerSchema,
  eventWorkflowTriggerSchema,
  manualWorkflowTriggerSchema,
  signalWorkflowTriggerSchema,
]);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export const workflowStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run_skill"),
    id: z.string(),
    skillSlug: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    id: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("llm_call"),
    id: z.string(),
    prompt: z.string(),
    model: z.string().optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent_run"),
    id: z.string(),
    workflowSlug: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("condition"),
    id: z.string(),
    expr: z.string(),
    onTrue: z.string(),
    onFalse: z.string(),
  }),
  z.object({
    kind: z.literal("parallel"),
    id: z.string(),
    branches: z.array(z.string()),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("loop"),
    id: z.string(),
    over: z.string(),
    body: z.string(),
    next: z.string().optional(),
  }),
  z.object({
    kind: z.literal("hil_approve"),
    id: z.string(),
    prompt: z.string().optional(),
    next: z.string().optional(),
  }),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowStepsSchema = z.array(workflowStepSchema);
export type WorkflowSteps = z.infer<typeof workflowStepsSchema>;

export const workflowHilGatesSchema = z.array(z.string());
export type WorkflowHilGates = z.infer<typeof workflowHilGatesSchema>;

// ── Workflow revisions (#555, docs/plans/workflows-v1.md) ────────────────────
//
// A workflow row is the stable identity the user controls; a revision is the
// immutable definition a run executes. The two pointers on `workflows` differ
// on purpose: `current_revision_id` is the newest draft, and
// `published_revision_id` is what new occurrences pin. An unattended run must
// keep the definition it started with, so editing an active workflow may never
// change what is already scheduled.

/**
 * One thing a revision needs before it may run: an exact registered tool, and —
 * when the tool can bind to more than one target — the account and the resource
 * boundary the user approved. `resolveWorkflowCapabilities` (#557) produces
 * these; this schema fixes only the stored shape.
 */
export const workflowRequiredCapabilitySchema = z.object({
  tool: toolNameSchema,
  /** Which connected account/installation the tool must use, when more than one exists. */
  accountRef: z.string().min(1).max(200).optional(),
  /** Provider-specific resource boundary (a repository, a calendar, a Slack channel). */
  resourceScope: jsonObjectSchema
    .refine((value) => Object.keys(value).length > 0, "Resource scope cannot be empty")
    .optional(),
});
export type WorkflowRequiredCapability = z.infer<typeof workflowRequiredCapabilitySchema>;

/** A model request may name a capability that Alfred does not implement yet. */
export const workflowRequestedCapabilitySchema = workflowRequiredCapabilitySchema.extend({
  tool: z.string().trim().min(1).max(200),
});
export type WorkflowRequestedCapability = z.infer<typeof workflowRequestedCapabilitySchema>;

/**
 * One truthful next step for a blocked workflow draft. The action is data, not
 * a URL: each authoring surface owns its navigation while the resolver owns
 * which recovery can actually change the readiness verdict.
 */
export const workflowRecoveryActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connect"),
    integration: integrationSlugSchema,
  }),
  z.object({
    kind: z.literal("reauthorize"),
    integration: integrationSlugSchema,
    accountRef: z.string().min(1).max(200).optional(),
    acceptableScopes: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({
    kind: z.literal("choose_account"),
    integration: integrationSlugSchema,
  }),
  z.object({
    kind: z.literal("grant_resource"),
    integration: integrationSlugSchema,
    accountRef: z.string().min(1).max(200).optional(),
    resourceScope: jsonObjectSchema,
  }),
  z.object({
    kind: z.literal("enable_feature"),
    integration: integrationSlugSchema,
  }),
  z.object({ kind: z.literal("retry") }),
]);
export type WorkflowRecoveryAction = z.infer<typeof workflowRecoveryActionSchema>;

/**
 * What the authoring turn understood and assumed, kept beside the revision so
 * the activation card (#556) can show the user the intent behind the contract
 * rather than opaque identifiers. It is outside the definition content hash,
 * but a changed proposal still creates a revision so the approved explanation
 * remains attributable to the row that was published.
 */
export const workflowAuthoringProposalSchema = z.object({
  /** The user's request, as the authoring turn read it. */
  intent: z.string().min(1).max(4000),
  /** Statements the user approves along with the definition. */
  assumptions: z.array(z.string().min(1).max(500)).max(20),
  /** Categories of external change this workflow may cause ("sends email"). */
  externalEffects: z.array(z.string().min(1).max(200)).max(20),
  /** What authoring asked for, before the resolver narrowed the envelope. */
  requestedCapabilities: z.array(workflowRequestedCapabilitySchema).max(50),
  /** Friendly schedule text for the card ("every weekday at 7:00 AM ET"). */
  scheduleSummary: z.string().max(200).optional(),
});
export type WorkflowAuthoringProposal = z.infer<typeof workflowAuthoringProposalSchema>;

/**
 * An operational blocker on a workflow — a missing connection, an expired
 * watch, a capability the envelope no longer satisfies.
 *
 * This is a separate field from `status` because the two answer different
 * questions. `status='paused'` is the user's intent; `blocked` is the machine's
 * readiness. Writing one must never overwrite the other, or reconnecting an
 * account silently un-pauses a workflow the user paused on purpose.
 */
export const workflowBlockedSchema = z.object({
  /** Stable machine code: `missing_capability`, `trigger_not_ready`, `reauth_required`, … */
  code: z.string().min(1).max(80),
  /** One safe sentence for the user. Never raw provider text. */
  message: z.string().min(1).max(500),
  /** ISO-8601 instant the blocker was observed. */
  detectedAt: z.string(),
  /** The revision the blocker was observed against, when known. */
  revisionId: z.string().min(1).optional(),
});
export type WorkflowBlocked = z.infer<typeof workflowBlockedSchema>;

/**
 * The definition half of a revision — every field a run's behavior depends on,
 * and nothing else. This exact object is what `workflowRevisionContentHash`
 * digests, so a semantic no-op edit re-hashes to the same value and appends no
 * revision. Pointers, timestamps, the revision number and the authoring
 * proposal stay out for that reason.
 */
export const workflowRevisionDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  /**
   * Natural-language brief — required, because a revision with no brief has
   * nothing to run. Built-ins keep a null `workflows.brief` and mint no
   * revision at all, so they never reach this schema.
   */
  brief: z.string().min(1).max(20000),
  trigger: workflowTriggerSchema,
  /** Coarse dispatcher backstop: which integrations a run may load at all. */
  allowedIntegrations: z.array(integrationSlugSchema).max(20),
  /** Exact envelope: the only tool names a run may activate or dispatch. */
  allowedTools: z.array(toolNameSchema).max(100),
  /** What must be ready before a run starts. Each tool here is in `allowedTools`. */
  requiredCapabilities: z.array(workflowRequiredCapabilitySchema).max(50),
});
export type WorkflowRevisionDefinition = z.infer<typeof workflowRevisionDefinitionSchema>;

/** The trigger subset a user may author in workflows v1 (#556). */
export const authorableWorkflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    schedule: z
      .string()
      .trim()
      .refine((value) => value.split(/\s+/).length === 5, "Expected a five-field cron expression"),
    timezone: z.string().refine(isIanaTimezone, "Expected an IANA timezone identifier"),
  }),
  z.object({
    kind: z.literal("event"),
    source: z.literal("gmail"),
    type: z.literal("message_received"),
    /** Canonical provider account id after server resolution. */
    accountRef: z.string().min(1).max(200).optional(),
  }),
  manualWorkflowTriggerSchema,
]);
export type AuthorableWorkflowTrigger = z.infer<typeof authorableWorkflowTriggerSchema>;

/** Model-facing proposal accepted by `system.author_workflow`. */
export const authorWorkflowInputSchema = z
  .object({
    workflowId: z.string().min(1).optional(),
    expectedRowVersion: z.coerce.number().int().positive().optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    brief: z.string().min(1).max(20000),
    trigger: authorableWorkflowTriggerSchema,
    capabilities: z.array(workflowRequestedCapabilitySchema).min(1).max(50),
    intent: z.string().min(1).max(4000),
    assumptions: z.array(z.string().min(1).max(500)).max(20),
    externalEffects: z.array(z.string().min(1).max(200)).max(20),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.workflowId && input.expectedRowVersion === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedRowVersion"],
        message: "expectedRowVersion is required when revising an existing workflow",
      });
    }
    if (!input.workflowId && input.expectedRowVersion !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expectedRowVersion"],
        message: "expectedRowVersion is only valid with workflowId",
      });
    }
  });
export type AuthorWorkflowInput = z.infer<typeof authorWorkflowInputSchema>;

export const workflowSchedulePreviewSchema = z
  .object({
    summary: z.string().min(1).max(200),
    timezone: z.string().refine(isIanaTimezone, "Expected an IANA timezone identifier"),
    previewedAt: z.string().datetime(),
    nextRunAt: z.string().optional(),
  })
  .strict();
export type WorkflowSchedulePreview = z.infer<typeof workflowSchedulePreviewSchema>;

export const workflowAccountDisplaySchema = z.object({
  provider: z.string().min(1).max(80),
  accountRef: z.string().min(1).max(200),
  accountLabel: z.string().min(1).max(200),
});
export type WorkflowAccountDisplay = z.infer<typeof workflowAccountDisplaySchema>;

export const workflowCapabilityDisplaySchema = z.object({
  tool: toolNameSchema,
  title: z.string().min(1).max(200),
  accountRef: z.string().min(1).max(200).optional(),
  accountLabel: z.string().min(1).max(200).optional(),
  resourceScope: jsonObjectSchema.optional(),
});
export type WorkflowCapabilityDisplay = z.infer<typeof workflowCapabilityDisplaySchema>;

export const authorableWorkflowDefinitionSchema = workflowRevisionDefinitionSchema.safeExtend({
  trigger: authorableWorkflowTriggerSchema,
});
export type AuthorableWorkflowDefinition = z.infer<typeof authorableWorkflowDefinitionSchema>;

/**
 * Exact contract staged by `system.activate_workflow`. It carries both the
 * immutable base identity and the full editable definition, so approval never
 * binds only opaque database ids.
 */
export const activateWorkflowInputSchema = z
  .object({
    workflowId: z.string().min(1).meta({ readOnly: true }),
    baseRevisionId: z.string().min(1).meta({ readOnly: true }),
    baseContentHash: z.string().min(1).max(256).meta({ readOnly: true }),
    baseRowVersion: z.coerce.number().int().positive().meta({ readOnly: true }),
    definition: authorableWorkflowDefinitionSchema,
    schedule: workflowSchedulePreviewSchema.meta({ readOnly: true }),
    resolvedAccounts: z.array(workflowAccountDisplaySchema).meta({ readOnly: true }),
    resolvedCapabilities: z.array(workflowCapabilityDisplaySchema).meta({ readOnly: true }),
    authoringProposal: workflowAuthoringProposalSchema.meta({ readOnly: true }),
  })
  .strict();
export type ActivateWorkflowInput = z.infer<typeof activateWorkflowInputSchema>;
