import {
  activateWorkflowInputSchema,
  authorableWorkflowDefinitionSchema,
  canonicalJson,
  getPath,
  integrationFromToolName,
  isIntegrationSlug,
  isLoadableIntegrationSlug,
  toolCategoryOf,
  toolLabel,
  workflowRevisionDefinitionSchema,
  workflowAuthoringProposalSchema,
  type ActivateWorkflowInput,
  type AuthorableWorkflowDefinition,
  type WorkflowAuthoringProposal,
  type WorkflowBlocked,
  type IanaTimezone,
  type WorkflowRevisionDefinition,
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
import { readFreshIntegrationAvailability } from "../integrations/availability";
import { createToolCatalog, listRegisteredTools, type ToolCatalog } from "../tools/registry";
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
 * The workflow draft / revision / activation service (#555,
 * `docs/plans/workflows-v1.md` § "Workflow identity and immutable revisions").
 *
 * **This module is the only writer of a workflow definition.** The chat
 * authoring tools, the activation approval, and the Replicache editor mutator
 * all come through here. That is not a style preference — `workflows` keeps a
 * denormalized copy of the published definition (the cron tick indexes
 * `workflows.trigger`, and the settings list reads one row instead of a join),
 * and a copy with two writers is a copy that drifts. A second
 * `UPDATE workflows SET trigger = …` anywhere in the codebase silently
 * downgrades the immutability rule below to advice.
 *
 * Three rules the shape of this file enforces:
 *
 *   1. **Revisions are append-only.** `revise` never updates a revision row.
 *      The one mutable column is `approved_at`, stamped by `activate`.
 *   2. **Editing does not disturb what is running.** The copy on `workflows`
 *      mirrors the *published* revision, so a new draft moves
 *      `current_revision_id` and nothing else. It mirrors the current revision
 *      only while `published_revision_id` is still null — a draft that has
 *      never been activated has nothing to protect.
 *   3. **Pause and blocked never travel together.** `status` is the user's
 *      intent, `blocked` is the machine's readiness. Each has its own writer
 *      here, and neither reads the other.
 */

// ── Result and failure shapes ────────────────────────────────────────────────

/** Why a definition is not activatable. Distinct codes so the card can point at a field. */
export type WorkflowRevisionProblemCode =
  | "invalid_definition"
  | "invalid_cron"
  | "unschedulable_cron"
  | "empty_integration_ceiling"
  | "trigger_source_not_allowed"
  | "tool_outside_ceiling"
  | "capability_outside_envelope"
  | "tool_without_capability"
  | "ambiguous_tool_capability"
  | "integration_outside_derived_ceiling";

export interface WorkflowRevisionProblem {
  code: WorkflowRevisionProblemCode;
  /** One safe sentence. Rendered on the activation card and in the blocked-draft state. */
  message: string;
  /** Dotted path into the definition, when the problem belongs to one field. */
  field?: string;
}

export type WorkflowServiceFailure =
  | { kind: "not_found" }
  | { kind: "builtin_immutable" }
  | { kind: "slug_taken"; slug: string }
  | { kind: "no_current_revision" }
  /** The caller's `expectedRowVersion` lost a race. The caller re-reads and retries. */
  | { kind: "row_version_conflict"; expected: number }
  | { kind: "readiness_blocked"; blockers: WorkflowReadinessProblem[] }
  /** The approval card was built against a definition that has since changed. */
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

/** Every write path returns the workflow row and the revision it settled on. */
export interface WorkflowRevisionOutcome {
  workflow: Workflow;
  revision: WorkflowRevision;
}

export interface WorkflowRevisedOutcome extends WorkflowRevisionOutcome {
  /**
   * `false` when the edit hashed to the current revision's content. The caller
   * should tell the user nothing changed rather than claim a new draft.
   */
  created: boolean;
}

export interface RecoveredWorkflowDraftOutcome extends WorkflowRevisionOutcome {
  readiness: WorkflowReadinessProblem[];
  activationProposal?: ActivateWorkflowInput;
}

/** A read executor or an existing transaction supplied by a composing caller. */
type WorkflowExecutor = DbRoot | DbTransaction;

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Parse and check a proposed definition. Pure over the supplied timezone: it
 * performs no database reads, so authoring, the activation approval, and any
 * future UI mutator all reach the same verdict from the same inputs.
 *
 * The input is `unknown` on purpose. It arrives from a model proposal, an
 * approval card the user may have edited, or a Replicache mutator payload —
 * none of which the server may trust to already match the schema.
 *
 * `requireActivatable` is the difference between "may I save this?" and "may I
 * publish this?". A draft is allowed to be incomplete — that is the whole point
 * of the blocked-draft flow, where the user leaves to connect an account and
 * comes back to the same draft. What may never be incomplete is a definition
 * about to run unattended, so {@link activateWorkflow} is the caller that turns
 * the flag on.
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

  // An empty ceiling means "not decided yet", not "everything is allowed". A
  // draft may sit in that state; a workflow about to run unattended may not,
  // because its runs could load any integration the user never approved for it.
  const hasCeiling = allowedIntegrations.length > 0;
  if (!hasCeiling && opts.requireActivatable) {
    problems.push({
      code: "empty_integration_ceiling",
      message: "A workflow must name the integrations it may use before it runs.",
      field: "allowedIntegrations",
    });
  }

  // The run has to be able to act on what fired it (ADR-0047). `EVENT_SOURCES`
  // is a wider namespace than `IntegrationSlug` — `learn-skill` and
  // `google.oauth.callback` are internal signals with no integration to allow —
  // so the cap applies only to the sources that name one.
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

  // `system` and `mcp` tools are not lazily loaded per integration, so they sit
  // outside the coarse ceiling by design; only loadable integrations are capped.
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

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateWorkflowDraftArgs {
  userId: string;
  /** Stable slug, unique per user. Callers derive it from the name before calling. */
  slug: string;
  /** Unvalidated proposal; `validateWorkflowDefinition` is applied here. */
  definition: unknown;
  authoringProposal?: WorkflowAuthoringProposal;
  /** The `agent_runs.id` that authored this. Retrying that run collapses onto one row. */
  createdByRunId?: string;
  tx?: DbTransaction;
}

/**
 * Create a user-authored workflow in `draft` with revision 1.
 *
 * A draft is never scheduled — `status` stays `draft` and `next_run_at` stays
 * null until {@link activateWorkflow} publishes. That is what lets authoring
 * save a proposal the user has not approved yet, including one blocked on a
 * connection the user still has to set up.
 */
export async function createWorkflowDraft(
  args: CreateWorkflowDraftArgs,
): Promise<WorkflowServiceResult<WorkflowRevisionOutcome>> {
  const timezone = await resolveTimezoneForInput(args.userId, args.definition);
  const validated = validateWorkflowDefinition(args.definition, { timezone });
  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

  const definition = validated.definition;
  const revisionId = createId("wfr");
  const run = async (
    tx: DbTransaction,
  ): Promise<WorkflowServiceResult<WorkflowRevisionOutcome>> => {
    // Insert the stable identity first, then the revision, then its pointer.
    // This order satisfies the pointer FK while the transaction keeps the
    // three writes atomic.
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

/**
 * The definition fields as they exist right now, before validation.
 *
 * Looser than `WorkflowRevisionDefinition` in one place: `brief` may still be
 * null. A row written before revisions existed has no brief, and the merge
 * below has to be able to carry that null forward so the validator — not the
 * merge — is what reports it.
 */
export type WorkflowDefinitionDraft = Omit<WorkflowRevisionDefinition, "brief"> & {
  brief: string | null;
};

/** A partial edit. An absent key means "leave it alone"; `null` means "clear it". */
export type WorkflowDefinitionPatch = {
  [K in keyof WorkflowDefinitionDraft]?: WorkflowDefinitionDraft[K] | undefined;
};

export interface ReviseWorkflowArgs {
  userId: string;
  workflowId: string;
  definition: unknown;
  authoringProposal?: WorkflowAuthoringProposal | undefined;
  createdByRunId?: string | undefined;
  /**
   * The `row_version` the caller read. Omit it only when no concurrent editor
   * is possible; supplying it turns a lost update into a typed conflict.
   */
  expectedRowVersion?: number | undefined;
  tx?: DbTransaction;
}

/**
 * Append a new revision and point `current_revision_id` at it.
 *
 * Two things happen before any row is written. The definition is hashed and
 * compared against the current revision, so a save that changes nothing
 * semantic returns `created: false` instead of a revision the user has to
 * re-approve. Then the workflow row is claimed with a compare-and-set on
 * `row_version` — which is both the lost-update guard and the lock that makes
 * the `revision_number = max + 1` read below safe, since a concurrent reviser
 * blocks on that row until this transaction commits and then fails its own CAS.
 */
export async function reviseWorkflow(
  args: ReviseWorkflowArgs,
): Promise<WorkflowServiceResult<WorkflowRevisedOutcome>> {
  const timezone = await resolveTimezoneForInput(args.userId, args.definition);
  const validated = validateWorkflowDefinition(args.definition, { timezone });
  if (!validated.ok) {
    return { ok: false, failure: { kind: "validation_failed", problems: validated.problems } };
  }

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
    // The published revision keeps running, so only a workflow that has never
    // been activated refreshes its denormalized copy from this edit.
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

    // The FK requires the immutable row to exist before either pointer can
    // reference it. The claim above already serialized concurrent editors;
    // this second update completes that claimed transition without another
    // row-version increment.
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
 * Revise from a partial edit — the entry point for an editor that sends only
 * the fields the user touched.
 *
 * The merge lives here rather than in the caller because "what does this row
 * currently mean?" is a question with a subtle answer: the current revision
 * when there is one, and the denormalized columns on `workflows` when there is
 * not (a row that predates revisions, or one a test inserted directly). A
 * caller that guessed wrong would silently drop `allowed_tools` on every save.
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

/**
 * Merge field by field rather than by spread. Under
 * `exactOptionalPropertyTypes` a present-but-undefined key still overwrites, so
 * a spread would clear every field the editor did not send.
 */
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
  /**
   * The content hash the approval card was built from. When it no longer
   * matches, activation stops rather than publishing a contract the user never
   * saw. Omit only for a reactivation of an unchanged workflow.
   */
  expectedContentHash?: string;
  expectedRowVersion?: number;
  tx?: DbTransaction;
}

export interface ActivateWorkflowDefinitionArgs {
  userId: string;
  /** Full activation contract from the approval card, including any user edits. */
  input: unknown;
  createdByRunId?: string;
}

/**
 * Rebuild an edited activation card from server-owned facts. The original
 * staging remains pending, so the user must approve this refreshed contract
 * before the parked run can continue.
 */
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

  const { availability, gmailEventHealth } = await readWorkflowReadinessContext(args.userId);
  const toolCatalog = createToolCatalog(listRegisteredTools());
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
    availability,
    requestedCapabilities: definition.requiredCapabilities,
    gmailEventHealth,
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
 * Revalidate one exact immutable draft after a connection or permission flow.
 *
 * Account canonicalization is projected into the activation proposal without
 * mutating the base revision. If approval changes the canonical definition,
 * {@link activateWorkflowDefinition} appends the approved revision before it
 * publishes. This keeps the user on the same draft while preserving the
 * append-only revision invariant.
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

  const { availability, gmailEventHealth } = await readWorkflowReadinessContext(args.userId);
  const toolCatalog = createToolCatalog(listRegisteredTools());
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
    availability,
    requestedCapabilities: baseProposal.data.requestedCapabilities,
    gmailEventHealth,
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

/** Add all executable effects and replace fields that the definition owns. */
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

/** Build the one exact activation contract shown by every authoring surface. */
export function buildWorkflowActivationProposal(args: {
  workflowId: string;
  baseRevisionId: string;
  baseContentHash: string;
  baseRowVersion: number;
  definition: AuthorableWorkflowDefinition;
  authoringProposal: WorkflowAuthoringProposal;
  availability: Awaited<ReturnType<typeof readFreshIntegrationAvailability>>;
  toolCatalog: ToolCatalog;
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
 * Activate the exact definition carried by an approval card (#556).
 *
 * The current pointer must still identify the card's base revision. A changed
 * pointer is stale even if a later revision happens to have the same hash. If
 * the user edited the card, the approved definition is appended as a new
 * immutable revision and that new revision is published in the same
 * transaction. The base row is never mutated.
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

  // Classify a stale approval by its immutable identity before validating the
  // editable contract. A stale base hash is not a malformed definition, and
  // callers need the typed stale result so they can restage the same draft.
  // The write transaction repeats this check to protect against a later race.
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
  const toolCatalog = createToolCatalog(listRegisteredTools());
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

  // The friendly preview is part of what the user approved. A trigger edit
  // that makes it stale must be restaged with a fresh server preview; silently
  // publishing the recomputed schedule would activate a contract the card did
  // not show.
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
 * Publish the current revision: `published_revision_id = current_revision_id`.
 *
 * The same call reactivates a paused workflow, because the plan requires
 * reactivation to re-run the identical validation as creation — a workflow
 * paused for a month may reference a tool that no longer exists.
 *
 * Activation rechecks readiness and clears an obsolete `blocked` state before
 * publishing. The run's `check-readiness` step still protects later drift.
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
    const { availability, gmailEventHealth } = await readWorkflowReadinessContext(args.userId);
    const toolCatalog = createToolCatalog(listRegisteredTools());
    const blockers = resolveWorkflowReadiness({
      definition,
      availability,
      requestedCapabilities: proposal.success
        ? proposal.data.requestedCapabilities
        : definition.requiredCapabilities,
      gmailEventHealth,
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

    // `approved_at` is the one mutable column on an otherwise immutable row, and
    // it is stamped once: republishing an already-approved revision keeps the
    // instant the user actually approved it.
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

// ── Status and blocked — independent fields, independent writers ─────────────

/**
 * Project one readiness verdict onto `workflows.blocked` in the transaction
 * that owns the revision. A draft cannot clear or replace the blocker for a
 * different published revision.
 */
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
    const message = args.readiness.map((problem) => problem.message).join(" ");
    if (
      args.workflow.blocked?.code === first.code &&
      args.workflow.blocked.message === message &&
      args.workflow.blocked.revisionId === args.revisionId
    ) {
      return { ok: true, workflow: args.workflow };
    }
    return writeBlocked(
      args.userId,
      args.workflow.id,
      {
        code: first.code,
        message,
        detectedAt: new Date().toISOString(),
        revisionId: args.revisionId,
      },
      args.tx,
    );
  }
  if (args.target === "activation" || args.workflow.blocked === null) {
    return { ok: true, workflow: args.workflow };
  }
  return writeBlocked(args.userId, args.workflow.id, null, args.tx);
}

/**
 * The statuses a plain status write may set. `active` is absent on purpose:
 * becoming active means publishing a revision, so it can only be reached
 * through {@link activateWorkflow}. Leaving it out of the type is what stops a
 * caller from flipping the flag without the validation behind it.
 */
export type InactiveWorkflowStatus = "paused" | "draft" | "archived";

/**
 * Stop future occurrences. Does not touch `blocked`, and does not touch a run
 * already in flight (pausing a run is a separate operation). `next_run_at` is
 * cleared, so the row leaves the cron tick's partial index.
 */
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

/**
 * Record an operational blocker. Does not touch `status`: a dead Gmail watch
 * must not read back as "the user paused this".
 */
export async function setWorkflowBlocked(args: {
  userId: string;
  workflowId: string;
  blocked: WorkflowBlocked;
  tx?: WorkflowExecutor;
}): Promise<WorkflowServiceResult<{ workflow: Workflow }>> {
  return writeBlocked(args.userId, args.workflowId, args.blocked, args.tx);
}

/**
 * Clear the blocker after recovery. Does not resume the workflow — a workflow
 * the user paused stays paused once its connection comes back.
 */
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

/**
 * The columns on `workflows` that mirror a revision. Kept in one place so every
 * writer copies the same set — a mirror that forgets `trigger` leaves the cron
 * index pointing at the old schedule.
 */
function mirroredColumns(definition: WorkflowRevisionDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    brief: definition.brief,
    trigger: definition.trigger,
    allowedIntegrations: definition.allowedIntegrations,
  };
}

/** The definition fields of a stored revision, in the shape the validator takes. */
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

/**
 * Resolve the timezone the cron check runs in, before the definition is known
 * to be valid. Reads the trigger defensively: the input is still untrusted at
 * this point, and an unparseable one simply falls back to the user's zone,
 * where the validator then reports the real problem.
 */
async function resolveTimezoneForInput(userId: string, input: unknown): Promise<IanaTimezone> {
  const trigger = workflowRevisionDefinitionSchema.shape.trigger.safeParse(
    getPath(input, "trigger"),
  );
  return trigger.success
    ? resolveWorkflowTimezone(userId, trigger.data)
    : resolveWorkflowTimezone(userId, { kind: "manual" });
}
