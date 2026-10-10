import { z } from "zod";
import { integrationSlugSchema, isIanaTimezone } from "./briefing";
import {
  AUTHORABLE_EVENT_SOURCES,
  authorableEventTriggerIssue,
  EVENT_SOURCES,
  rawEventKindSchema,
} from "./event-triggers";
import { canonicalJson, toolNameSchema } from "./tools";
import { isRecord } from "./guards";
import { jsonObjectSchema } from "./user-model";

/**
 * Status of an `agent_runs` row. Append members; never reorder them.
 * `runIsNotTerminal` renders this order into partial index predicates,
 * so a reorder recreates those indexes.
 */
export const runStatusSchema = z.enum([
  "pending",
  "runnable",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "deferred",
  "blocked",
]);

export const RUN_STATUSES = Object.freeze([...runStatusSchema.options]);

export type RunStatus = z.infer<typeof runStatusSchema>;

/** A data table, so a new status without an entry fails the build. */
const RUN_STATUS_KIND = {
  pending: "live",
  runnable: "live",
  running: "live",
  waiting: "live",
  completed: "terminal",
  failed: "terminal",
  cancelled: "terminal",
  deferred: "live",
  blocked: "terminal",
} as const satisfies Record<RunStatus, "live" | "terminal">;

export function isTerminalStatus(s: RunStatus): boolean {
  return RUN_STATUS_KIND[s] === "terminal";
}

/** In `runStatusSchema` order. SQL uses `runIsNotTerminal` from `@alfred/db`, not this list. */
export const TERMINAL_RUN_STATUSES = Object.freeze(RUN_STATUSES.filter(isTerminalStatus));

export const agentStepStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "deferred",
  "blocked",
]);

export type AgentStepStatus = z.infer<typeof agentStepStatusSchema>;

const AGENT_STEP_STATUS_KIND = {
  running: "live",
  completed: "progress",
  failed: "failure",
  interrupted: "parked_progress",
  deferred: "parked_progress",
  blocked: "terminal",
} as const satisfies Record<
  AgentStepStatus,
  "live" | "progress" | "failure" | "parked_progress" | "terminal"
>;

/** Step states that prove the executor committed useful progress. */
export const AGENT_STEP_PROGRESS_STATUSES = Object.freeze(
  agentStepStatusSchema.options.filter(
    (status) =>
      AGENT_STEP_STATUS_KIND[status] === "progress" ||
      AGENT_STEP_STATUS_KIND[status] === "parked_progress",
  ),
);

/** A committed step whose following wall-clock gap is intentional wait time. */
export function isParkedAgentStepStatus(status: string): boolean {
  const parsed = agentStepStatusSchema.safeParse(status);

  return parsed.success && AGENT_STEP_STATUS_KIND[parsed.data] === "parked_progress";
}

/**
 * What a `hil` wake waits on: a workflow step gate (ADR-0017), a gated tool call (ADR-0034),
 * or a `system.ask_user` question (ADR-0099). All share the `action_stagings` row and route.
 */
export const approvalKindSchema = z.enum(["step", "action_staging", "question"]);

export type ApprovalKind = z.infer<typeof approvalKindSchema>;

export const wakeConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hil"),
    approvalId: z.string(),
    approvalKind: approvalKindSchema.optional(),
    prompt: z.string().optional(),
  }),
  z.object({ kind: z.literal("timer"), wakeAt: z.string() }),
  z.object({
    kind: z.literal("signal"),
    name: z.string(),
    /**
     * When the wait gives up. Optional so wakes parked before it existed still parse, and because
     * the interrupt seams still accept a raw signal wake. The join reconciler gives any signal wake
     * without it the sub-agent ceiling from its park time. Item 29 makes it required.
     */
    deadlineAt: z.string().datetime().optional(),
  }),
]);

export type WakeCondition = z.infer<typeof wakeConditionSchema>;

/** One firing without its payload. `agentRunTriggerSchema` adds the payload to events. */
export const cronRunTriggerIdentitySchema = z.object({
  kind: z.literal("cron"),
  scheduledFor: z.string(),
});

export const eventRunTriggerIdentitySchema = z.object({
  kind: z.literal("event"),
  // Optional: old event runs predate ADR-0047 source/type fields.
  source: z.string().optional(),
  type: z.string().optional(),
  /** The provider kind of a raw event (`type: "raw"`). */
  rawKind: rawEventKindSchema.optional(),
  eventId: z.string(),
});

export const manualRunTriggerIdentitySchema = z.object({ kind: z.literal("manual") });

export const signalRunTriggerIdentitySchema = z.object({
  kind: z.literal("on_signal"),
  signalName: z.string(),
});

export const agentRunTriggerSchema = z.discriminatedUnion("kind", [
  cronRunTriggerIdentitySchema,
  eventRunTriggerIdentitySchema.extend({
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  manualRunTriggerIdentitySchema,
  signalRunTriggerIdentitySchema,
]);

export type AgentRunTrigger = z.infer<typeof agentRunTriggerSchema>;

export const cronWorkflowTriggerSchema = z.object({
  kind: z.literal("cron"),
  schedule: z.string(),
  timezone: z.string().optional(),
});

export const eventWorkflowTriggerSchema = z.object({
  kind: z.literal("event"),
  // `emitEvent` matches on source and type (ADR-0047), so writes need `type`.
  source: z.enum(EVENT_SOURCES),
  type: z.string(),
  /** Set only when `type` is raw. Matched against the receipt's `raw_kind`. */
  rawKind: rawEventKindSchema.optional(),
  /** Provider account for user-authored external events. */
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

// ── Workflow revisions ───────────────────────────────────────────────────────
//
// A run executes an immutable revision. `current_revision_id` is the newest draft;
// `published_revision_id` is what new occurrences pin, so an edit never changes a scheduled run.

/**
 * A tool a revision needs before it runs, plus the approved account and resource
 * when the tool can bind to more than one. `resolveWorkflowCapabilities` produces these.
 */
export const workflowRequiredCapabilitySchema = z.object({
  tool: toolNameSchema,
  /** The account or installation to use, when there is more than one. */
  accountRef: z.string().min(1).max(200).optional(),
  /** A provider resource: a repository, a calendar, a Slack channel. */
  resourceScope: jsonObjectSchema
    .refine((value) => Object.keys(value).length > 0, "Resource scope cannot be empty")
    .optional(),
});

export type WorkflowRequiredCapability = z.infer<typeof workflowRequiredCapabilitySchema>;

/** Scope keys name input fields; each value must match as canonical JSON. */
export function inputMatchesWorkflowResourceScope(
  input: unknown,
  resourceScope: NonNullable<WorkflowRequiredCapability["resourceScope"]>,
): boolean {
  if (!isRecord(input)) return false;

  return Object.entries(resourceScope).every(
    ([key, approved]) => key in input && canonicalJson(input[key]) === canonicalJson(approved),
  );
}

/** A model request may name a capability that Alfred does not implement yet. */
export const workflowRequestedCapabilitySchema = workflowRequiredCapabilitySchema.extend({
  tool: z.string().trim().min(1).max(200),
});

export type WorkflowRequestedCapability = z.infer<typeof workflowRequestedCapabilitySchema>;

/** A next step for a blocked draft. Data, not a URL: each surface owns its navigation. */
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

/** Server-owned navigation for a recovery action the current product can execute. */
export const workflowRecoveryNavigationSchema = z.object({
  kind: z.literal("oauth"),
  label: z.string().min(1).max(120),
  path: z.string().startsWith("/api/integrations/").max(1_000),
});

export type WorkflowRecoveryNavigation = z.infer<typeof workflowRecoveryNavigationSchema>;

/**
 * What authoring understood, for the activation card. Outside the content hash,
 * but a changed proposal still creates a revision.
 */
export const workflowAuthoringProposalSchema = z.object({
  intent: z.string().min(1).max(4000),
  /** Statements the user approves along with the definition. */
  assumptions: z.array(z.string().min(1).max(500)).max(20),
  /** Categories of external change this workflow may cause ("sends email"). */
  externalEffects: z.array(z.string().min(1).max(200)).max(20),
  /** Before the resolver narrows the envelope. */
  requestedCapabilities: z.array(workflowRequestedCapabilitySchema).max(50),
  scheduleSummary: z.string().max(200).optional(),
});

export type WorkflowAuthoringProposal = z.infer<typeof workflowAuthoringProposalSchema>;

/**
 * A machine blocker on a workflow. Separate from `status='paused'`, which is user intent.
 * Write one without touching the other, or a reconnect un-pauses a paused workflow.
 */
export const workflowBlockedSchema = z.object({
  code: z.string().min(1).max(80),
  /** Never raw provider text. */
  message: z.string().min(1).max(500),
  detectedAt: z.string(),
  /** When the notification went out. */
  notifiedAt: z.string().optional(),
  revisionId: z.string().min(1).optional(),
});

export type WorkflowBlocked = z.infer<typeof workflowBlockedSchema>;

/**
 * Blocker identity: code, message, revision. Same generation means no second email.
 * Every blocker comparison goes through this.
 */
export function workflowBlockedGeneration(
  blocked: Pick<WorkflowBlocked, "code" | "message" | "revisionId">,
): string {
  return canonicalJson({
    code: blocked.code,
    message: blocked.message,
    revisionId: blocked.revisionId ?? null,
  });
}

/**
 * Every field a run depends on, and nothing else. `workflowRevisionContentHash` digests
 * this, so a no-op edit appends no revision.
 */
export const workflowRevisionDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  /** Required. Built-ins have no brief and mint no revision. */
  brief: z.string().min(1).max(20000),
  trigger: workflowTriggerSchema,
  /** Coarse backstop: the integrations a run may load. */
  allowedIntegrations: z.array(integrationSlugSchema).max(20),
  /** The only tools a run may activate or dispatch. */
  allowedTools: z.array(toolNameSchema).max(100),
  /** Each tool here is also in `allowedTools`. */
  requiredCapabilities: z.array(workflowRequiredCapabilitySchema).max(50),
});

export type WorkflowRevisionDefinition = z.infer<typeof workflowRevisionDefinitionSchema>;

/**
 * The event trigger a user may author. Shared by the editor mutator and chat authoring.
 * The server's revision service checks that the source has seen the `rawKind`.
 */
export const authorableEventTriggerSchema = z
  .object({
    kind: z.literal("event"),
    source: z.enum(AUTHORABLE_EVENT_SOURCES),
    type: z
      .string()
      .min(1)
      .describe("gmail: 'message_received'. github/sentry: 'raw' plus rawKind."),
    rawKind: rawEventKindSchema
      .optional()
      .describe(
        "A kind from the integration's unmapped events (e.g. 'comment.created'). Required with type 'raw'.",
      ),
    /** Set by the server after resolution. */
    accountRef: z.string().min(1).max(200).optional(),
  })
  .superRefine((trigger, ctx) => {
    const issue = authorableEventTriggerIssue(trigger);

    if (issue) ctx.addIssue({ code: "custom", message: issue.message, path: [issue.path] });
  });

export const authorableWorkflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    schedule: z
      .string()
      .trim()
      .refine((value) => value.split(/\s+/).length === 5, "Expected a five-field cron expression"),
    timezone: z.string().refine(isIanaTimezone, "Expected an IANA timezone identifier"),
  }),
  authorableEventTriggerSchema,
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

/** Staged by `system.activate_workflow`: base identity plus the full definition, not bare ids. */
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
