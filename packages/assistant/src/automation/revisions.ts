import {
  activateWorkflowInputSchema,
  authorableWorkflowDefinitionSchema,
  canonicalJson,
  getPath,
  integrationFromToolName,
  isInboundEventSource,
  isIntegrationSlug,
  isLoadableIntegrationSlug,
  isRawEventType,
  rawEventTriggerIssue,
  toolCategoryOf,
  toolLabel,
  workflowBlockedGeneration,
  workflowRevisionDefinitionSchema,
  workflowAuthoringProposalSchema,
  type ActivateWorkflowInput,
  type AuthorableWorkflowDefinition,
  type WorkflowAuthoringProposal,
  type WorkflowBlocked,
  type IanaTimezone,
  type WorkflowRevisionDefinition,
  type WorkflowTrigger,
} from "@alfred/contracts";
import { db, type DbRoot, type DbTransaction } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import {
  workflowRevisions,
  workflows,
  type Workflow,
  type WorkflowRevision,
} from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { canonicalWorkflowDefinition, workflowRevisionContentHash } from "./content-hash";
import { readFreshIntegrationAvailability, seenRawKinds } from "@alfred/assistant/connections";
import { workflowToolCatalog, type WorkflowToolCatalog } from "@alfred/assistant/tool-runtime";
import {
  canonicalizeWorkflowAccounts,
  resolveWorkflowApprovalDisplay,
  resolveWorkflowReadiness,
  type WorkflowReadinessProblem,
} from "./readiness";
import {
  computeNextRunAt,
  resolveWorkflowTimezone,
  validateCronTrigger,
  workflowScheduleSummary,
} from "./scheduling";
import { readWorkflowReadinessContext } from "./readiness-context";

/**
 * Workflow draft, revision, and activation service (#555).
 * This is the only writer of a user workflow definition (the seeder writes built-ins).
 * `workflows` keeps a copy of the published definition for the cron index, and a copy
 * with two writers drifts.
 * Rules:
 *   1. Revisions are append-only. Only `approved_at` changes, set by `activate`.
 *   2. A new draft moves only `current_revision_id`. The copy on `workflows` follows the
 *      published revision, or the current one while nothing is published.
 *   3. `status` is user intent and `blocked` is machine readiness. Neither writer touches the other.
 */

// ── Result and failure shapes ────────────────────────────────────────────────

/** Distinct codes so the card can point at a field. */
export type WorkflowRevisionProblemCode =
  | "invalid_definition"
  | "invalid_cron"
  | "unschedulable_cron"
  /** Raw trigger without a source or kind, or a typed trigger with a kind (#990). */
  | "invalid_raw_trigger"
  /** Raw trigger on a kind the source never delivered to this user (#990). */
  | "unseen_raw_kind"
  | "empty_integration_ceiling"
  | "trigger_source_not_allowed"
  | "tool_outside_ceiling"
  | "capability_outside_envelope"
  | "tool_without_capability"
  | "ambiguous_tool_capability"
  | "integration_outside_derived_ceiling";

export interface WorkflowRevisionProblem {
  code: WorkflowRevisionProblemCode;
  /** One safe sentence for the activation card. */
  message: string;
  /** Dotted path, when the problem belongs to one field. */
  field?: string;
}

export type WorkflowServiceFailure =
  | { kind: "not_found" }
  | { kind: "builtin_immutable" }
  | { kind: "slug_taken"; slug: string }
  | { kind: "no_current_revision" }
  /** The caller re-reads and retries. */
  | { kind: "row_version_conflict"; expected: number }
  | { kind: "readiness_blocked"; blockers: WorkflowReadinessProblem[] }
  /** The approval card was built from an older definition. */
  | {
      kind: "stale_revision";
      expected: string;
      actual: string;
      expectedRevisionId?: string;
      actualRevisionId?: string;
    }
  | { kind: "validation_failed"; problems: WorkflowRevisionProblem[] };

export type WorkflowServiceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; failure: WorkflowServiceFailure };

export interface WorkflowRevisionOutcome {
  workflow: Workflow;
  revision: WorkflowRevision;
}

export interface WorkflowRevisedOutcome extends WorkflowRevisionOutcome {
  /** `false` when nothing changed. Tell the user so; do not claim a new draft. */
  created: boolean;
}

export interface RecoveredWorkflowDraftOutcome extends WorkflowRevisionOutcome {
  readiness: WorkflowReadinessProblem[];
  activationProposal?: ActivateWorkflowInput;
}

type WorkflowExecutor = DbRoot | DbTransaction;

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Parse and check a definition. No database reads, so every caller gets the same verdict.
 * Input is `unknown`: it comes from a model, an edited card, or a mutator.
 * Drafts may be incomplete (the user may still need to connect an account).
 * `requireActivatable` rejects anything that cannot run unattended.
 */
export function validateWorkflowDefinition(
  input: unknown,
  opts: { timezone: IanaTimezone; requireActivatable?: boolean },
):
  | { ok: true; definition: WorkflowRevisionDefinition }
  | { ok: false; problems: WorkflowRevisionProblem[] } {
  const parsed = workflowRevisionDefinitionSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        code: "invalid_definition" as const,
        message: issue.message,
        field: issue.path.join("."),
      })),
    };
  }

  const definition = canonicalWorkflowDefinition(parsed.data);
  const problems: WorkflowRevisionProblem[] = [];
  const { trigger, allowedIntegrations, allowedTools, requiredCapabilities } = definition;

  // Whether the source delivered the kind is a DB fact; see {@link unseenRawKindProblem}.
  if (trigger.kind === "event") {
    const issue = rawEventTriggerIssue(trigger);

    if (issue) {
      problems.push({
        code: "invalid_raw_trigger",
        message: issue.message,
        field: `trigger.${issue.path}`,
      });
    }
  }

  if (trigger.kind === "cron") {
    const cron = validateCronTrigger(trigger, { timezone: opts.timezone });

    if (!cron.ok) {
      problems.push({ code: "invalid_cron", message: cron.message, field: "trigger.schedule" });
    } else if (!computeNextRunAt(trigger, { timezone: opts.timezone })) {
      problems.push({
        code: "unschedulable_cron",
        message: "That schedule never fires again.",
        field: "trigger.schedule",
      });
    }
  }

  // An empty ceiling means "not decided", not "everything". A running workflow needs one.
  const hasCeiling = allowedIntegrations.length > 0;

  if (!hasCeiling && opts.requireActivatable) {
    problems.push({
      code: "empty_integration_ceiling",
      message: "A workflow must name the integrations it may use before it runs.",
      field: "allowedIntegrations",
    });
  }

  // The run must be able to act on its trigger (ADR-0047). Some sources, like
  // `learn-skill`, are internal signals with no integration to allow.
  if (
    hasCeiling &&
    trigger.kind === "event" &&
    isIntegrationSlug(trigger.source) &&
    !allowedIntegrations.includes(trigger.source)
  ) {
    problems.push({
      code: "trigger_source_not_allowed",
      message: `The allowed integrations must include the event source '${trigger.source}'.`,
      field: "allowedIntegrations",
    });
  }

  // `system` and `mcp` tools are not loaded per integration, so the ceiling skips them.
  for (const tool of hasCeiling ? allowedTools : []) {
    const integration = integrationFromToolName(tool);

    if (!isLoadableIntegrationSlug(integration)) continue;

    if (allowedIntegrations.includes(integration)) continue;
    problems.push({
      code: "tool_outside_ceiling",
      message: `'${tool}' needs '${integration}' in the allowed integrations.`,
      field: "allowedTools",
    });
  }

  for (const capability of requiredCapabilities) {
    if (allowedTools.includes(capability.tool)) continue;
    problems.push({
      code: "capability_outside_envelope",
      message: `'${capability.tool}' is required but is not in the allowed tools.`,
      field: "requiredCapabilities",
    });
  }

  const capabilityTools = new Set(requiredCapabilities.map((capability) => capability.tool));

  for (const tool of allowedTools) {
    if (capabilityTools.has(tool)) continue;
    problems.push({
      code: "tool_without_capability",
      message: `'${tool}' is allowed but has no matching required capability.`,
      field: "allowedTools",
    });
  }

  const capabilityCountByTool = new Map<string, number>();

  for (const capability of requiredCapabilities) {
    capabilityCountByTool.set(
      capability.tool,
      (capabilityCountByTool.get(capability.tool) ?? 0) + 1,
    );
  }

  for (const [tool, count] of capabilityCountByTool) {
    if (count === 1) continue;
    problems.push({
      code: "ambiguous_tool_capability",
      message: `'${tool}' must select exactly one account and resource boundary per revision.`,
      field: "requiredCapabilities",
    });
  }

  const derivedIntegrations = new Set(allowedTools.map((tool) => integrationFromToolName(tool)));

  if (trigger.kind === "event" && isIntegrationSlug(trigger.source)) {
    derivedIntegrations.add(trigger.source);
  }

  for (const integration of allowedIntegrations) {
    if (derivedIntegrations.has(integration)) continue;

    if (!opts.requireActivatable) continue;
    problems.push({
      code: "integration_outside_derived_ceiling",
      message: `'${integration}' is allowed but is not required by a tool or trigger.`,
      field: "allowedIntegrations",
    });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, definition };
}

/**
 * A raw trigger may name only a kind its source has delivered to this user (#990).
 * The message lists the seen kinds so chat authoring can retry with a real one.
 * Runs on the paths that write a definition, not on activation.
 */
async function unseenRawKindProblem(
  userId: string,
  trigger: WorkflowTrigger,
): Promise<WorkflowRevisionProblem | null> {
  if (trigger.kind !== "event" || !isRawEventType(trigger.type)) return null;

  if (!isInboundEventSource(trigger.source) || !trigger.rawKind) return null;
  const kinds = await seenRawKinds(userId, trigger.source);

  if (kinds.includes(trigger.rawKind)) return null;

  const seen =
    kinds.length > 0
      ? `Kinds it has delivered: ${kinds.join(", ")}.`
      : "It has delivered no unmapped events yet.";

  return {
    code: "unseen_raw_kind",
    message: `'${trigger.source}' has not delivered a '${trigger.rawKind}' event. ${seen}`,
    field: "trigger.rawKind",
  };
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateWorkflowDraftArgs {
  userId: string;
  /** Unique per user. */
  slug: string;
  /** Validated here. */
  definition: unknown;
  authoringProposal?: WorkflowAuthoringProposal;
  /** A retry of the same run collapses onto one row. */
  createdByRunId?: string;
  tx?: DbTransaction;
}

/**
 * Create a `draft` with revision 1. Drafts are never scheduled until
 * {@link activateWorkflow}, so authoring can save an unapproved or blocked proposal.
 */
export async function createWorkflowDraft(
  args: CreateWorkflowDraftArgs,
): Promise<WorkflowServiceResult<WorkflowRevisionOutcome>> {
  const timezone = await resolveTimezoneForInput(args.userId, args.definition);
  const validated = validateWorkflowDefinition(args.definition, { timezone });

  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

  const unseen = await unseenRawKindProblem(args.userId, validated.definition.trigger);

  if (unseen) return { ok: false, failure: { kind: "validation_failed", problems: [unseen] } };

  const definition = validated.definition;
  const revisionId = createId("wfr");

  const run = async (
    tx: DbTransaction,
  ): Promise<WorkflowServiceResult<WorkflowRevisionOutcome>> => {
    // Workflow, then revision, then pointer: the order the FK needs.
    const [created] = await tx
      .insert(workflows)
      .values({
        userId: args.userId,
        slug: args.slug,
        status: "draft",
        isBuiltin: false,
        ...mirroredColumns(definition),
      })
      .onConflictDoNothing({ target: [workflows.userId, workflows.slug] })
      .returning();

    if (!created) return { ok: false, failure: { kind: "slug_taken", slug: args.slug } };

    const revision = await insertRevision(tx, {
      id: revisionId,
      workflowId: created.id,
      userId: args.userId,
      revisionNumber: 1,
      definition,
      authoringProposal: args.authoringProposal,
      createdByRunId: args.createdByRunId,
    });

    const [workflow] = await tx
      .update(workflows)
      .set({ currentRevisionId: revisionId })
      .where(eq(workflows.id, created.id))
      .returning();

    if (!workflow) return { ok: false, failure: { kind: "not_found" } };

    return { ok: true, workflow, revision };
  };

  return args.tx ? run(args.tx) : db().transaction(run);
}

// ── Revise ───────────────────────────────────────────────────────────────────

/** Like `WorkflowRevisionDefinition`, but `brief` may be null on pre-revision rows. The validator reports it. */
export type WorkflowDefinitionDraft = Omit<WorkflowRevisionDefinition, "brief"> & {
  brief: string | null;
};

/** Absent key means "leave it"; `null` means "clear it". */
export type WorkflowDefinitionPatch = {
  [K in keyof WorkflowDefinitionDraft]?: WorkflowDefinitionDraft[K] | undefined;
};

export interface ReviseWorkflowArgs {
  userId: string;
  workflowId: string;
  definition: unknown;
  authoringProposal?: WorkflowAuthoringProposal | undefined;
  createdByRunId?: string | undefined;
  /** Omit only when no concurrent editor is possible. */
  expectedRowVersion?: number | undefined;
  tx?: DbTransaction;
}

/**
 * Append a revision and point `current_revision_id` at it.
 * An unchanged hash returns `created: false`, so the user need not re-approve.
 * The `row_version` CAS guards lost updates and locks the row, which makes the
 * `max + 1` revision number safe.
 */
export async function reviseWorkflow(
  args: ReviseWorkflowArgs,
): Promise<WorkflowServiceResult<WorkflowRevisedOutcome>> {
  const timezone = await resolveTimezoneForInput(args.userId, args.definition);
  const validated = validateWorkflowDefinition(args.definition, { timezone });

  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

  const unseen = await unseenRawKindProblem(args.userId, validated.definition.trigger);

  if (unseen) return { ok: false, failure: { kind: "validation_failed", problems: [unseen] } };

  const definition = validated.definition;

  const run = async (tx: DbTransaction): Promise<WorkflowServiceResult<WorkflowRevisedOutcome>> => {
    const existing = await loadWorkflow(tx, args.userId, args.workflowId);

    if (!existing) return { ok: false, failure: { kind: "not_found" } };

    if (existing.isBuiltin) return { ok: false, failure: { kind: "builtin_immutable" } };

    const current = existing.currentRevisionId
      ? await loadRevision(tx, existing.currentRevisionId)
      : null;

    const contentHash = workflowRevisionContentHash(definition);

    const proposalUnchanged =
      canonicalJson(current?.authoringProposal ?? null) ===
      canonicalJson(args.authoringProposal ?? null);

    if (current && current.contentHash === contentHash && proposalUnchanged) {
      return { ok: true, workflow: existing, revision: current, created: false };
    }

    const revisionId = createId("wfr");
    // Only a never-activated workflow refreshes its copy; the published revision keeps running.
    const mirrors = existing.publishedRevisionId === null;

    const nextRunAt =
      mirrors && existing.status === "active"
        ? computeNextRunAt(definition.trigger, { timezone })
        : undefined;

    const expectedRowVersion = args.expectedRowVersion ?? existing.rowVersion;

    const [claimed] = await tx
      .update(workflows)
      .set({
        rowVersion: sql`${workflows.rowVersion} + 1`,
      })
      .where(rowVersionGuard(existing.id, expectedRowVersion))
      .returning();

    if (!claimed) {
      return {
        ok: false,
        failure: { kind: "row_version_conflict", expected: expectedRowVersion },
      };
    }

    const revision = await insertRevision(tx, {
      id: revisionId,
      workflowId: existing.id,
      userId: args.userId,
      revisionNumber: (current?.revisionNumber ?? 0) + 1,
      definition,
      authoringProposal: args.authoringProposal,
      createdByRunId: args.createdByRunId,
    });

    // The revision must exist before a pointer can reference it. The claim above already locked the row.
    const [workflow] = await tx
      .update(workflows)
      .set({
        currentRevisionId: revisionId,
        ...(mirrors ? mirroredColumns(definition) : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      })
      .where(eq(workflows.id, existing.id))
      .returning();

    if (!workflow) return { ok: false, failure: { kind: "not_found" } };

    return { ok: true, workflow, revision, created: true };
  };

  return args.tx ? run(args.tx) : db().transaction(run);
}

/**
 * Revise from the fields the editor sent. The base is the current revision, or the
 * `workflows` columns when there is none. A wrong base would drop `allowed_tools`.
 */
export async function reviseWorkflowFromPatch(args: {
  userId: string;
  workflowId: string;
  patch: WorkflowDefinitionPatch;
  authoringProposal?: WorkflowAuthoringProposal | undefined;
  createdByRunId?: string | undefined;
  expectedRowVersion?: number | undefined;
  tx?: DbTransaction;
}): Promise<WorkflowServiceResult<WorkflowRevisedOutcome>> {
  const run = async (tx: DbTransaction): Promise<WorkflowServiceResult<WorkflowRevisedOutcome>> => {
    const existing = await loadWorkflow(tx, args.userId, args.workflowId);

    if (!existing) return { ok: false, failure: { kind: "not_found" } };

    if (existing.isBuiltin) return { ok: false, failure: { kind: "builtin_immutable" } };

    const current = existing.currentRevisionId
      ? await loadRevision(tx, existing.currentRevisionId)
      : null;

    const base: WorkflowDefinitionDraft = current
      ? definitionOf(current)
      : {
          name: existing.name,
          description: existing.description,
          brief: existing.brief,
          trigger: existing.trigger,
          allowedIntegrations: workflowRevisionDefinitionSchema.shape.allowedIntegrations.parse(
            existing.allowedIntegrations,
          ),
          allowedTools: [],
          requiredCapabilities: [],
        };

    return reviseWorkflow({
      userId: args.userId,
      workflowId: args.workflowId,
      definition: applyDefinitionPatch(base, args.patch),
      authoringProposal: args.authoringProposal,
      createdByRunId: args.createdByRunId,
      expectedRowVersion: args.expectedRowVersion,
      tx,
    });
  };

  return args.tx ? run(args.tx) : db().transaction(run);
}

/** Not a spread: under `exactOptionalPropertyTypes` an undefined key would clear the field. */
function applyDefinitionPatch(
  base: WorkflowDefinitionDraft,
  patch: WorkflowDefinitionPatch,
): WorkflowDefinitionDraft {
  return {
    name: patch.name ?? base.name,
    description: patch.description !== undefined ? patch.description : base.description,
    brief: patch.brief !== undefined ? patch.brief : base.brief,
    trigger: patch.trigger ?? base.trigger,
    allowedIntegrations: patch.allowedIntegrations ?? base.allowedIntegrations,
    allowedTools: patch.allowedTools ?? base.allowedTools,
    requiredCapabilities: patch.requiredCapabilities ?? base.requiredCapabilities,
  };
}

// ── Activate ─────────────────────────────────────────────────────────────────

export interface ActivateWorkflowArgs {
  userId: string;
  workflowId: string;
  /** The hash the card was built from. Omit only to reactivate an unchanged workflow. */
  expectedContentHash?: string;
  expectedRowVersion?: number;
  tx?: DbTransaction;
}

export interface ActivateWorkflowDefinitionArgs {
  userId: string;
  /** The card's contract, with any user edits. */
  input: unknown;
  createdByRunId?: string;
}

/** Rebuild an edited card from server facts. The user must approve the new card. */
export async function refreshWorkflowActivationProposal(args: {
  userId: string;
  input: unknown;
}): Promise<
  WorkflowServiceResult<{ input: ReturnType<typeof activateWorkflowInputSchema.parse> }>
> {
  const parsed = activateWorkflowInputSchema.safeParse(args.input);

  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        problems: parsed.error.issues.map((issue) => ({
          code: "invalid_definition",
          message: issue.message,
          field: issue.path.join("."),
        })),
      },
    };
  }

  const requested = parsed.data;
  const existing = await loadWorkflow(db(), args.userId, requested.workflowId);

  if (!existing) return { ok: false, failure: { kind: "not_found" } };

  if (existing.isBuiltin) return { ok: false, failure: { kind: "builtin_immutable" } };

  if (!existing.currentRevisionId) {
    return { ok: false, failure: { kind: "no_current_revision" } };
  }

  const current = await loadRevision(db(), existing.currentRevisionId);

  if (!current) return { ok: false, failure: { kind: "no_current_revision" } };

  const stale = staleRevisionFailure(existing, current, {
    revisionId: requested.baseRevisionId,
    contentHash: requested.baseContentHash,
    rowVersion: requested.baseRowVersion,
  });

  if (stale) return { ok: false, failure: stale };

  const context = await readWorkflowReadinessContext(args.userId);
  const { availability } = context;
  const toolCatalog = workflowToolCatalog();

  const canonicalDefinition = canonicalizeWorkflowAccounts({
    definition: requested.definition,
    availability,
    toolCatalog,
  });

  const timezone = await resolveTimezoneForInput(args.userId, canonicalDefinition);

  const validated = validateWorkflowDefinition(canonicalDefinition, {
    timezone,
    requireActivatable: true,
  });

  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

  const definition = authorableWorkflowDefinitionSchema.parse(validated.definition);
  const baseProposal = workflowAuthoringProposalSchema.safeParse(current.authoringProposal);

  if (!baseProposal.success) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        problems: [
          {
            code: "invalid_definition",
            message: "The stored workflow proposal is invalid and cannot be approved.",
            field: "authoringProposal",
          },
        ],
      },
    };
  }

  const blockers = resolveWorkflowReadiness({
    definition,
    context,
    requestedCapabilities: definition.requiredCapabilities,
    toolCatalog,
  });

  if (blockers.length > 0) {
    return { ok: false, failure: { kind: "readiness_blocked", blockers } };
  }

  return {
    ok: true,
    input: buildWorkflowActivationProposal({
      workflowId: existing.id,
      baseRevisionId: current.id,
      baseContentHash: current.contentHash,
      baseRowVersion: existing.rowVersion,
      definition,
      authoringProposal: baseProposal.data,
      availability,
      toolCatalog,
      timezone,
    }),
  };
}

/**
 * Revalidate one draft after a connection or permission flow.
 * The base revision is not changed; {@link activateWorkflowDefinition} appends one if needed.
 */
export async function recoverWorkflowDraft(args: {
  userId: string;
  workflowId: string;
  revisionId: string;
}): Promise<WorkflowServiceResult<RecoveredWorkflowDraftOutcome>> {
  const initialWorkflow = await loadWorkflow(db(), args.userId, args.workflowId);

  if (!initialWorkflow) return { ok: false, failure: { kind: "not_found" } };

  if (initialWorkflow.isBuiltin) {
    return { ok: false, failure: { kind: "builtin_immutable" } };
  }

  const baseRevision = await loadRevision(db(), args.revisionId);

  if (
    !baseRevision ||
    baseRevision.userId !== args.userId ||
    baseRevision.workflowId !== initialWorkflow.id
  ) {
    return { ok: false, failure: { kind: "not_found" } };
  }

  if (initialWorkflow.currentRevisionId !== baseRevision.id) {
    const current = initialWorkflow.currentRevisionId
      ? await loadRevision(db(), initialWorkflow.currentRevisionId)
      : null;

    return {
      ok: false,
      failure: {
        kind: "stale_revision",
        expected: baseRevision.contentHash,
        actual: current?.contentHash ?? "missing",
        expectedRevisionId: baseRevision.id,
        ...(current ? { actualRevisionId: current.id } : {}),
      },
    };
  }

  const storedDefinition = definitionOf(baseRevision);
  const baseProposal = workflowAuthoringProposalSchema.safeParse(baseRevision.authoringProposal);

  if (!baseProposal.success) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        problems: [
          {
            code: "invalid_definition",
            message: "The stored workflow proposal is invalid and cannot be recovered.",
            field: "authoringProposal",
          },
        ],
      },
    };
  }

  const context = await readWorkflowReadinessContext(args.userId);
  const { availability } = context;
  const toolCatalog = workflowToolCatalog();

  const canonicalDefinition = canonicalizeWorkflowAccounts({
    definition: storedDefinition,
    availability,
    toolCatalog,
  });

  const timezone = await resolveTimezoneForInput(args.userId, canonicalDefinition);

  const validated = validateWorkflowDefinition(canonicalDefinition, {
    timezone,
    requireActivatable: true,
  });

  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

  const definition = authorableWorkflowDefinitionSchema.parse(validated.definition);

  const readiness = resolveWorkflowReadiness({
    definition,
    context,
    requestedCapabilities: baseProposal.data.requestedCapabilities,
    toolCatalog,
  });

  return db().transaction(async (tx) => {
    const workflow = await loadWorkflow(tx, args.userId, args.workflowId);

    if (!workflow) return { ok: false, failure: { kind: "not_found" } };

    const current = workflow.currentRevisionId
      ? await loadRevision(tx, workflow.currentRevisionId)
      : null;

    if (
      !current ||
      current.id !== baseRevision.id ||
      current.contentHash !== baseRevision.contentHash
    ) {
      return {
        ok: false,
        failure: {
          kind: "stale_revision",
          expected: baseRevision.contentHash,
          actual: current?.contentHash ?? "missing",
          expectedRevisionId: baseRevision.id,
          ...(current ? { actualRevisionId: current.id } : {}),
        },
      };
    }

    const reconciled = await reconcileWorkflowReadiness({
      userId: args.userId,
      workflow,
      revisionId: current.id,
      readiness,
      target: "draft",
      tx,
    });

    if (!reconciled.ok) return reconciled;

    return {
      ok: true,
      workflow: reconciled.workflow,
      revision: current,
      readiness,
      ...(readiness.length === 0
        ? {
            activationProposal: buildWorkflowActivationProposal({
              workflowId: reconciled.workflow.id,
              baseRevisionId: current.id,
              baseContentHash: current.contentHash,
              baseRowVersion: reconciled.workflow.rowVersion,
              definition,
              authoringProposal: baseProposal.data,
              availability,
              toolCatalog,
              timezone,
            }),
          }
        : {}),
    };
  });
}

/** Add executable effects and take definition-owned fields from the definition. */
export function approvalProposalForDefinition(
  base: WorkflowAuthoringProposal,
  definition: WorkflowRevisionDefinition,
): WorkflowAuthoringProposal {
  const derivedEffects = definition.requiredCapabilities.flatMap((capability) => {
    if (
      integrationFromToolName(capability.tool) === "system" ||
      toolCategoryOf(capability.tool) !== "action"
    ) {
      return [];
    }

    return [toolLabel(capability.tool)?.title ?? capability.tool];
  });

  return {
    intent: base.intent,
    assumptions: base.assumptions,
    externalEffects: [...new Set([...base.externalEffects, ...derivedEffects])],
    requestedCapabilities: definition.requiredCapabilities,
    scheduleSummary: workflowScheduleSummary(definition.trigger),
  };
}

/** The one activation contract every authoring surface shows. */
export function buildWorkflowActivationProposal(args: {
  workflowId: string;
  baseRevisionId: string;
  baseContentHash: string;
  baseRowVersion: number;
  definition: AuthorableWorkflowDefinition;
  authoringProposal: WorkflowAuthoringProposal;
  availability: Awaited<ReturnType<typeof readFreshIntegrationAvailability>>;
  toolCatalog: WorkflowToolCatalog;
  timezone: IanaTimezone;
  previewedAt?: Date | undefined;
}): ActivateWorkflowInput {
  const previewedAt = args.previewedAt ?? new Date();

  const nextRunAt = computeNextRunAt(args.definition.trigger, {
    from: previewedAt,
    timezone: args.timezone,
  });

  return {
    workflowId: args.workflowId,
    baseRevisionId: args.baseRevisionId,
    baseContentHash: args.baseContentHash,
    baseRowVersion: args.baseRowVersion,
    definition: args.definition,
    schedule: {
      summary: workflowScheduleSummary(args.definition.trigger),
      timezone: args.timezone,
      previewedAt: previewedAt.toISOString(),
      ...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
    },
    ...resolveWorkflowApprovalDisplay(args.definition, args.availability, args.toolCatalog),
    authoringProposal: approvalProposalForDefinition(args.authoringProposal, args.definition),
  };
}

/**
 * Activate the definition on an approval card (#556).
 * The current pointer must still be the card's base, even if a later revision has the same hash.
 * An edited card appends a new revision and publishes it in the same transaction.
 */
export async function activateWorkflowDefinition(
  args: ActivateWorkflowDefinitionArgs,
): Promise<WorkflowServiceResult<WorkflowRevisionOutcome & { revised: boolean }>> {
  const parsed = activateWorkflowInputSchema.safeParse(args.input);

  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        problems: parsed.error.issues.map((issue) => ({
          code: "invalid_definition",
          message: issue.message,
          field: issue.path.join("."),
        })),
      },
    };
  }

  const input = parsed.data;
  const inputHash = workflowRevisionContentHash(input.definition);

  const alreadyApplied = await db().transaction(async (tx) => {
    const existing = await loadWorkflow(tx, args.userId, input.workflowId);

    if (
      !existing ||
      existing.status !== "active" ||
      !existing.currentRevisionId ||
      existing.publishedRevisionId !== existing.currentRevisionId
    ) {
      return null;
    }

    const current = await loadRevision(tx, existing.currentRevisionId);

    if (
      !current?.approvedAt ||
      current.contentHash !== inputHash ||
      canonicalJson(current.authoringProposal) !== canonicalJson(input.authoringProposal)
    ) {
      return null;
    }

    return { workflow: existing, revision: current };
  });

  if (alreadyApplied) {
    return {
      ok: true,
      ...alreadyApplied,
      revised: alreadyApplied.revision.id !== input.baseRevisionId,
    };
  }

  // Report stale before validation, so callers get the typed result and can restage.
  // The write transaction checks again for a later race.
  const staleWorkflow = await loadWorkflow(db(), args.userId, input.workflowId);

  const staleRevision = staleWorkflow?.currentRevisionId
    ? await loadRevision(db(), staleWorkflow.currentRevisionId)
    : null;

  if (staleWorkflow && staleRevision) {
    const stale = staleRevisionFailure(staleWorkflow, staleRevision, {
      revisionId: input.baseRevisionId,
      contentHash: input.baseContentHash,
    });

    if (stale) return { ok: false, failure: stale };
  }

  const availability = await readFreshIntegrationAvailability(args.userId);
  const toolCatalog = workflowToolCatalog();

  const canonicalInputDefinition = canonicalizeWorkflowAccounts({
    definition: input.definition,
    availability,
    toolCatalog,
  });

  const timezone = await resolveTimezoneForInput(args.userId, canonicalInputDefinition);

  const validated = validateWorkflowDefinition(canonicalInputDefinition, {
    timezone,
    requireActivatable: true,
  });

  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

  const definition = validated.definition;
  const approvedHash = workflowRevisionContentHash(definition);
  const expectedDisplay = resolveWorkflowApprovalDisplay(definition, availability, toolCatalog);

  if (
    canonicalJson(input.resolvedAccounts) !== canonicalJson(expectedDisplay.resolvedAccounts) ||
    canonicalJson(input.resolvedCapabilities) !==
      canonicalJson(expectedDisplay.resolvedCapabilities)
  ) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        problems: [
          {
            code: "invalid_definition",
            message:
              "The account and capability display no longer matches the approved definition.",
            field: "resolvedCapabilities",
          },
        ],
      },
    };
  }

  // The user approved the shown schedule. If it is stale, restage; do not publish a new one.
  const scheduleProblems = validateActivationSchedule(input, timezone);

  if (scheduleProblems.length > 0) {
    return { ok: false, failure: { kind: "validation_failed", problems: scheduleProblems } };
  }

  return db().transaction(async (tx) => {
    const existing = await loadWorkflow(tx, args.userId, input.workflowId);

    if (!existing) return { ok: false, failure: { kind: "not_found" } };

    if (existing.isBuiltin) return { ok: false, failure: { kind: "builtin_immutable" } };

    if (!existing.currentRevisionId) {
      return { ok: false, failure: { kind: "no_current_revision" } };
    }

    const current = await loadRevision(tx, existing.currentRevisionId);

    if (!current) return { ok: false, failure: { kind: "no_current_revision" } };

    const stale = staleRevisionFailure(existing, current, {
      revisionId: input.baseRevisionId,
      contentHash: input.baseContentHash,
    });

    if (stale) return { ok: false, failure: stale };

    const baseProposal = workflowAuthoringProposalSchema.safeParse(current.authoringProposal);

    const expectedProposal = baseProposal.success
      ? approvalProposalForDefinition(baseProposal.data, definition)
      : null;

    if (
      !expectedProposal ||
      canonicalJson(input.authoringProposal) !== canonicalJson(expectedProposal)
    ) {
      return {
        ok: false,
        failure: {
          kind: "validation_failed",
          problems: [
            {
              code: "invalid_definition",
              message: "The proposal summary does not match the approved definition.",
              field: "authoringProposal",
            },
          ],
        },
      };
    }

    let revised = false;
    let expectedRowVersion = input.baseRowVersion;

    if (approvedHash !== current.contentHash) {
      const result = await reviseWorkflow({
        userId: args.userId,
        workflowId: input.workflowId,
        definition,
        authoringProposal: input.authoringProposal,
        createdByRunId: args.createdByRunId,
        expectedRowVersion: input.baseRowVersion,
        tx,
      });

      if (!result.ok) return result;
      revised = result.created;
      expectedRowVersion = result.workflow.rowVersion;
    }

    const activated = await activateWorkflow({
      userId: args.userId,
      workflowId: input.workflowId,
      expectedContentHash: approvedHash,
      expectedRowVersion,
      tx,
    });

    return activated.ok ? { ...activated, revised } : activated;
  });
}

function validateActivationSchedule(
  input: ReturnType<typeof activateWorkflowInputSchema.parse>,
  timezone: Awaited<ReturnType<typeof resolveWorkflowTimezone>>,
): WorkflowRevisionProblem[] {
  const problems: WorkflowRevisionProblem[] = [];
  const previewedAt = new Date(input.schedule.previewedAt);
  const expectedNext = computeNextRunAt(input.definition.trigger, { from: previewedAt, timezone });
  const currentNext = computeNextRunAt(input.definition.trigger, { from: new Date(), timezone });
  const expectedSummary = workflowScheduleSummary(input.definition.trigger);

  if (input.schedule.timezone !== timezone) {
    problems.push({
      code: "invalid_definition",
      message: "The schedule preview timezone no longer matches the approved definition.",
      field: "schedule.timezone",
    });
  }

  if (input.schedule.summary !== expectedSummary) {
    problems.push({
      code: "invalid_definition",
      message: "The schedule preview no longer matches the approved definition.",
      field: "schedule.summary",
    });
  }

  if ((input.schedule.nextRunAt ?? null) !== (expectedNext?.toISOString() ?? null)) {
    problems.push({
      code: "invalid_definition",
      message: "The next-run preview no longer matches the approved definition.",
      field: "schedule.nextRunAt",
    });
  }

  if ((input.schedule.nextRunAt ?? null) !== (currentNext?.toISOString() ?? null)) {
    problems.push({
      code: "invalid_definition",
      message: "The next-run preview has passed. Review the refreshed schedule.",
      field: "schedule.nextRunAt",
    });
  }

  return problems;
}

/**
 * Publish the current revision. Also reactivates a paused workflow, with full validation,
 * because a tool may have gone away. Rechecks readiness and clears an old `blocked`.
 */
export async function activateWorkflow(
  args: ActivateWorkflowArgs,
): Promise<WorkflowServiceResult<WorkflowRevisionOutcome>> {
  const run = async (
    tx: DbTransaction,
  ): Promise<WorkflowServiceResult<WorkflowRevisionOutcome>> => {
    const existing = await loadWorkflow(tx, args.userId, args.workflowId);

    if (!existing) return { ok: false, failure: { kind: "not_found" } };

    if (existing.isBuiltin) return { ok: false, failure: { kind: "builtin_immutable" } };

    if (!existing.currentRevisionId) return { ok: false, failure: { kind: "no_current_revision" } };

    const current = await loadRevision(tx, existing.currentRevisionId);

    if (!current) return { ok: false, failure: { kind: "no_current_revision" } };

    if (args.expectedContentHash && args.expectedContentHash !== current.contentHash) {
      return {
        ok: false,
        failure: {
          kind: "stale_revision",
          expected: args.expectedContentHash,
          actual: current.contentHash,
        },
      };
    }

    const timezone = await resolveWorkflowTimezone(args.userId, current.trigger);

    const validated = validateWorkflowDefinition(definitionOf(current), {
      timezone,
      requireActivatable: true,
    });

    if (!validated.ok) {
      return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
    }

    const definition = validated.definition;
    const proposal = workflowAuthoringProposalSchema.safeParse(current.authoringProposal);
    const context = await readWorkflowReadinessContext(args.userId);
    const toolCatalog = workflowToolCatalog();

    const blockers = resolveWorkflowReadiness({
      definition,
      context,
      requestedCapabilities: proposal.success
        ? proposal.data.requestedCapabilities
        : definition.requiredCapabilities,
      toolCatalog,
    });

    if (blockers[0]) {
      const reconciled = await reconcileWorkflowReadiness({
        userId: args.userId,
        workflow: existing,
        revisionId: current.id,
        readiness: blockers,
        target: "activation",
        tx,
      });

      if (!reconciled.ok) return reconciled;

      return { ok: false, failure: { kind: "readiness_blocked", blockers } };
    }

    const expectedRowVersion = args.expectedRowVersion ?? existing.rowVersion;

    const [published] = await tx
      .update(workflows)
      .set({
        status: "active",
        blocked: null,
        publishedRevisionId: current.id,
        nextRunAt: computeNextRunAt(definition.trigger, { timezone }),
        ...mirroredColumns(definition),
        rowVersion: sql`${workflows.rowVersion} + 1`,
      })
      .where(rowVersionGuard(existing.id, expectedRowVersion))
      .returning();

    if (!published) {
      return {
        ok: false,
        failure: { kind: "row_version_conflict", expected: expectedRowVersion },
      };
    }

    // Stamp `approved_at` once: a republish keeps the first approval time.
    const [revision] = await tx
      .update(workflowRevisions)
      .set({ approvedAt: new Date() })
      .where(
        and(eq(workflowRevisions.id, current.id), sql`${workflowRevisions.approvedAt} IS NULL`),
      )
      .returning();

    return { ok: true, workflow: published, revision: revision ?? current };
  };

  return args.tx ? run(args.tx) : db().transaction(run);
}

// ── Status and blocked: independent fields, independent writers ─────────────

/** Write a readiness verdict to `workflows.blocked`. A draft cannot change a published revision's blocker. */
export async function reconcileWorkflowReadiness(args: {
  userId: string;
  workflow: Workflow;
  revisionId: string;
  readiness: readonly WorkflowReadinessProblem[];
  target: "draft" | "activation";
  tx: DbTransaction;
}): Promise<WorkflowServiceResult<{ workflow: Workflow }>> {
  const ownsBlockedState =
    args.target === "activation" ||
    args.workflow.publishedRevisionId === null ||
    args.workflow.publishedRevisionId === args.revisionId;

  if (!ownsBlockedState) return { ok: true, workflow: args.workflow };

  const first = args.readiness[0];

  if (first) {
    const next: WorkflowBlocked = {
      code: first.code,
      message: args.readiness.map((problem) => problem.message).join(" "),
      detectedAt: new Date().toISOString(),
      revisionId: args.revisionId,
    };

    // Same generation is the same blocker: keep the row and its `notifiedAt`.
    if (
      args.workflow.blocked &&
      workflowBlockedGeneration(args.workflow.blocked) === workflowBlockedGeneration(next)
    ) {
      return { ok: true, workflow: args.workflow };
    }

    return writeBlocked(args.userId, args.workflow.id, next, args.tx);
  }

  if (args.target === "activation" || args.workflow.blocked === null) {
    return { ok: true, workflow: args.workflow };
  }

  return writeBlocked(args.userId, args.workflow.id, null, args.tx);
}

/** No `active`: only {@link activateWorkflow} may set it, with validation. */
export type InactiveWorkflowStatus = "paused" | "draft" | "archived";

/** Stop future runs. Leaves `blocked` and in-flight runs alone; clears `next_run_at`. */
export async function setWorkflowStatus(args: {
  userId: string;
  workflowId: string;
  status: InactiveWorkflowStatus;
  expectedRowVersion?: number | undefined;
  tx?: WorkflowExecutor;
}): Promise<WorkflowServiceResult<{ workflow: Workflow }>> {
  const executor = args.tx ?? db();

  const [workflow] = await executor
    .update(workflows)
    .set({ status: args.status, nextRunAt: null, rowVersion: sql`${workflows.rowVersion} + 1` })
    .where(
      and(
        eq(workflows.userId, args.userId),
        rowVersionGuard(args.workflowId, args.expectedRowVersion),
      ),
    )
    .returning();

  return workflow
    ? { ok: true, workflow }
    : args.expectedRowVersion === undefined
      ? { ok: false, failure: { kind: "not_found" } }
      : {
          ok: false,
          failure: { kind: "row_version_conflict", expected: args.expectedRowVersion },
        };
}

/** Leaves `status` alone: a dead Gmail watch must not look like a user pause. */
export async function setWorkflowBlocked(args: {
  userId: string;
  workflowId: string;
  blocked: WorkflowBlocked;
  tx?: WorkflowExecutor;
}): Promise<WorkflowServiceResult<{ workflow: Workflow }>> {
  return writeBlocked(args.userId, args.workflowId, args.blocked, args.tx);
}

/** Does not resume: a paused workflow stays paused. */
export async function clearWorkflowBlocked(args: {
  userId: string;
  workflowId: string;
  tx?: WorkflowExecutor;
}): Promise<WorkflowServiceResult<{ workflow: Workflow }>> {
  return writeBlocked(args.userId, args.workflowId, null, args.tx);
}

async function writeBlocked(
  userId: string,
  workflowId: string,
  blocked: WorkflowBlocked | null,
  tx?: WorkflowExecutor,
): Promise<WorkflowServiceResult<{ workflow: Workflow }>> {
  const executor = tx ?? db();

  const [workflow] = await executor
    .update(workflows)
    .set({ blocked, rowVersion: sql`${workflows.rowVersion} + 1` })
    .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)))
    .returning();

  return workflow ? { ok: true, workflow } : { ok: false, failure: { kind: "not_found" } };
}

// ── Internals ────────────────────────────────────────────────────────────────

function staleRevisionFailure(
  workflow: Workflow,
  revision: WorkflowRevision,
  expected: { revisionId: string; contentHash: string; rowVersion?: number },
): Extract<WorkflowServiceFailure, { kind: "stale_revision" }> | null {
  if (
    revision.id === expected.revisionId &&
    revision.contentHash === expected.contentHash &&
    (expected.rowVersion === undefined || workflow.rowVersion === expected.rowVersion)
  ) {
    return null;
  }

  return {
    kind: "stale_revision",
    expected: expected.contentHash,
    actual: revision.contentHash,
    expectedRevisionId: expected.revisionId,
    actualRevisionId: revision.id,
  };
}

/** Every writer copies this set. Forget `trigger` and the cron index keeps the old schedule. */
function mirroredColumns(definition: WorkflowRevisionDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    brief: definition.brief,
    trigger: definition.trigger,
    allowedIntegrations: definition.allowedIntegrations,
  };
}

function definitionOf(revision: WorkflowRevision): WorkflowRevisionDefinition {
  return {
    name: revision.name,
    description: revision.description,
    brief: revision.brief,
    trigger: revision.trigger,
    allowedIntegrations: revision.allowedIntegrations,
    allowedTools: revision.allowedTools,
    requiredCapabilities: revision.requiredCapabilities,
  };
}

function rowVersionGuard(workflowId: string, expectedRowVersion: number | undefined) {
  return expectedRowVersion === undefined
    ? eq(workflows.id, workflowId)
    : and(eq(workflows.id, workflowId), eq(workflows.rowVersion, expectedRowVersion));
}

async function loadWorkflow(
  executor: WorkflowExecutor,
  userId: string,
  workflowId: string,
): Promise<Workflow | null> {
  const [row] = await executor
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)))
    .limit(1);

  return row ?? null;
}

async function loadRevision(
  executor: WorkflowExecutor,
  revisionId: string,
): Promise<WorkflowRevision | null> {
  const [row] = await executor
    .select()
    .from(workflowRevisions)
    .where(eq(workflowRevisions.id, revisionId))
    .limit(1);

  return row ?? null;
}

async function insertRevision(
  executor: WorkflowExecutor,
  args: {
    id: string;
    workflowId: string;
    userId: string;
    revisionNumber: number;
    definition: WorkflowRevisionDefinition;
    authoringProposal?: WorkflowAuthoringProposal | undefined;
    createdByRunId?: string | undefined;
  },
): Promise<WorkflowRevision> {
  const [revision] = await executor
    .insert(workflowRevisions)
    .values({
      id: args.id,
      workflowId: args.workflowId,
      userId: args.userId,
      revisionNumber: args.revisionNumber,
      contentHash: workflowRevisionContentHash(args.definition),
      name: args.definition.name,
      description: args.definition.description,
      brief: args.definition.brief,
      trigger: args.definition.trigger,
      allowedIntegrations: args.definition.allowedIntegrations,
      allowedTools: args.definition.allowedTools,
      requiredCapabilities: args.definition.requiredCapabilities,
      authoringProposal: args.authoringProposal ?? null,
      createdByRunId: args.createdByRunId ?? null,
    })
    .returning();

  if (!revision) throw new Error("workflow revision insert returned no row");

  return revision;
}

/** Bad input falls back to the user's zone; the validator then reports the real problem. */
async function resolveTimezoneForInput(userId: string, input: unknown): Promise<IanaTimezone> {
  const trigger = workflowRevisionDefinitionSchema.shape.trigger.safeParse(
    getPath(input, "trigger"),
  );

  return trigger.success
    ? resolveWorkflowTimezone(userId, trigger.data)
    : resolveWorkflowTimezone(userId, { kind: "manual" });
}
