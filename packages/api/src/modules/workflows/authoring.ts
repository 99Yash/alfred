import {
  canonicalJson,
  authorableWorkflowDefinitionSchema,
  integrationFromToolName,
  isIntegrationSlug,
  isToolName,
  workflowAuthoringProposalSchema,
  type ActivateWorkflowInput,
  type AuthorableWorkflowDefinition,
  type AuthorWorkflowInput,
  type IanaTimezone,
  type IntegrationSlug,
  type WorkflowAuthoringProposal,
  type WorkflowRequiredCapability,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { workflows } from "@alfred/db/schemas";
import { and, eq, like } from "drizzle-orm";
import { availableSlug, slugBase } from "../../lib/slug";
import { workflowScheduleSummary } from "./scheduling";
import { readFreshIntegrationAvailability } from "../integrations/availability";
import { listRegisteredTools } from "../tools/registry";
import { readWorkflowReadinessContext } from "./readiness-context";
import {
  canonicalizeWorkflowAccounts,
  resolveWorkflowCapabilities,
  type WorkflowReadinessProblem,
} from "./readiness";
import {
  clearWorkflowBlocked,
  createWorkflowDraft,
  readWorkflowCurrentRevision,
  reviseWorkflow,
  setWorkflowBlocked,
  approvalProposalForDefinition,
  buildWorkflowActivationProposal,
  type WorkflowRevisionOutcome,
  type WorkflowServiceResult,
} from "./revisions";

export interface AuthoredWorkflowOutcome extends WorkflowRevisionOutcome {
  created: boolean;
  readiness: WorkflowReadinessProblem[];
  activationProposal?: ActivateWorkflowInput;
}

/**
 * Re-run readiness for the same saved draft after connect or reauthorization.
 * A changed account binding stays on the same workflow identity and is carried
 * in the new approval input; activation will append the attributable revision.
 */
export async function revalidateWorkflowDraft(args: {
  userId: string;
  workflowId: string;
  timezone: IanaTimezone;
}): Promise<WorkflowServiceResult<AuthoredWorkflowOutcome>> {
  const current = await readWorkflowCurrentRevision(args);
  if (!current.ok) return current;
  const proposal = workflowAuthoringProposalSchema.safeParse(current.revision.authoringProposal);
  const storedDefinition = authorableWorkflowDefinitionSchema.safeParse(current.definition);
  if (!proposal.success || !storedDefinition.success) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        problems: [
          {
            code: "invalid_definition",
            message: "The saved workflow cannot be revalidated for authoring.",
            field: !proposal.success ? "authoringProposal" : "definition",
          },
        ],
      },
    };
  }

  const { availability, gmailEventHealth } = await readWorkflowReadinessContext(args.userId);
  const candidate = canonicalizeWorkflowAccounts({
    definition: storedDefinition.data,
    availability,
  });
  const resolution = resolveWorkflowCapabilities({
    requested: proposal.data.requestedCapabilities,
    trigger: candidate.trigger,
    availability,
    registeredTools: listRegisteredTools(),
    gmailEventHealth,
  });
  const definition = {
    ...candidate,
    allowedIntegrations: resolution.allowedIntegrations,
    allowedTools: resolution.allowedTools,
  };
  let workflow = current.workflow;
  if (resolution.missing.length > 0) {
    const first = resolution.missing[0];
    if (!first) throw new Error("workflow readiness returned an empty blocker set");
    const blocked = await setWorkflowBlocked({
      userId: args.userId,
      workflowId: workflow.id,
      blocked: {
        code: first.code,
        message: resolution.missing.map((problem) => problem.message).join(" "),
        detectedAt: new Date().toISOString(),
        revisionId: current.revision.id,
      },
    });
    if (!blocked.ok) return blocked;
    workflow = blocked.workflow;
  } else if (workflow.blocked !== null) {
    const cleared = await clearWorkflowBlocked({
      userId: args.userId,
      workflowId: workflow.id,
    });
    if (!cleared.ok) return cleared;
    workflow = cleared.workflow;
  }

  return {
    ok: true,
    workflow,
    revision: current.revision,
    created: false,
    readiness: resolution.missing,
    ...(resolution.missing.length === 0
      ? {
          activationProposal: activationProposalFor({
            workflow,
            revision: current.revision,
            definition,
            authoringProposal: approvalProposalForDefinition(proposal.data, definition),
            availability,
            timezone: args.timezone,
          }),
        }
      : {}),
  };
}

/** Save a chat-authored proposal as a draft and return its exact approval input. */
export async function authorWorkflowDraft(args: {
  userId: string;
  runId: string;
  timezone: IanaTimezone;
  input: AuthorWorkflowInput;
}): Promise<WorkflowServiceResult<AuthoredWorkflowOutcome>> {
  // Gather mutable setup before the first write. A transient availability-read
  // failure must not commit a draft and then make a retry create a second one.
  const { availability, gmailEventHealth } = await readWorkflowReadinessContext(args.userId);
  const candidate = canonicalizeWorkflowAccounts({
    definition: definitionFromProposal(args.input),
    availability,
  });
  const resolution = resolveWorkflowCapabilities({
    requested: args.input.capabilities,
    trigger: candidate.trigger,
    availability,
    registeredTools: listRegisteredTools(),
    gmailEventHealth,
  });
  const definition = {
    ...candidate,
    allowedIntegrations: resolution.allowedIntegrations,
    allowedTools: resolution.allowedTools,
  };
  const authoringProposal = authoringProposalFromInput(args.input, definition);
  const readiness = resolution.missing;
  const slug = args.input.workflowId
    ? undefined
    : await workflowSlugForName(args.userId, args.input.name);

  return db().transaction(async (tx) => {
    let saved: WorkflowRevisionOutcome;
    let created: boolean;
    if (args.input.workflowId) {
      const revised = await reviseWorkflow({
        userId: args.userId,
        workflowId: args.input.workflowId,
        definition,
        authoringProposal,
        createdByRunId: args.runId,
        expectedRowVersion: args.input.expectedRowVersion,
        tx,
      });
      if (!revised.ok) return revised;
      saved = revised;
      created = revised.created;
    } else {
      if (!slug) throw new Error("new workflow authoring requires a resolved slug");
      const drafted = await createWorkflowDraft({
        userId: args.userId,
        slug,
        definition,
        authoringProposal,
        createdByRunId: args.runId,
        tx,
      });
      if (!drafted.ok) return drafted;
      saved = drafted;
      created = true;
    }

    if (readiness.length > 0) {
      const first = readiness[0];
      if (!first) throw new Error("workflow readiness returned an empty blocker set");
      const blocked = await setWorkflowBlocked({
        userId: args.userId,
        workflowId: saved.workflow.id,
        blocked: {
          code: first.code,
          message: readiness.map((problem) => problem.message).join(" "),
          detectedAt: new Date().toISOString(),
          revisionId: saved.revision.id,
        },
        tx,
      });
      if (!blocked.ok) return blocked;
      saved = { ...saved, workflow: blocked.workflow };
    } else if (saved.workflow.blocked !== null) {
      const cleared = await clearWorkflowBlocked({
        userId: args.userId,
        workflowId: saved.workflow.id,
        tx,
      });
      if (!cleared.ok) return cleared;
      saved = { ...saved, workflow: cleared.workflow };
    }

    return {
      ok: true,
      workflow: saved.workflow,
      revision: saved.revision,
      created,
      readiness,
      ...(readiness.length === 0
        ? {
            activationProposal: activationProposalFor({
              workflow: saved.workflow,
              revision: saved.revision,
              definition,
              authoringProposal,
              availability,
              timezone: args.timezone,
            }),
          }
        : {}),
    };
  });
}

/** Derive the exact stored execution envelope from the model-facing proposal. */
export function definitionFromProposal(input: AuthorWorkflowInput): AuthorableWorkflowDefinition {
  const requiredCapabilities = uniqueCapabilities(
    input.capabilities.flatMap((capability) =>
      isToolName(capability.tool) ? [{ ...capability, tool: capability.tool }] : [],
    ),
  );
  const allowedTools = [...new Set(requiredCapabilities.map((capability) => capability.tool))];
  const integrations = new Set<IntegrationSlug>(
    allowedTools.map((tool) => integrationFromToolName(tool)),
  );
  for (const capability of input.capabilities) {
    const prefix = capability.tool.slice(0, capability.tool.indexOf("."));
    if (isIntegrationSlug(prefix)) integrations.add(prefix);
  }
  if (input.trigger.kind === "event") integrations.add(input.trigger.source);

  return {
    name: input.name,
    description: input.description ?? null,
    brief: input.brief,
    trigger: input.trigger,
    allowedIntegrations: [...integrations],
    allowedTools,
    requiredCapabilities,
  };
}

function authoringProposalFromInput(
  input: AuthorWorkflowInput,
  definition: AuthorableWorkflowDefinition,
): WorkflowAuthoringProposal {
  return approvalProposalForDefinition(
    {
      intent: input.intent,
      assumptions: input.assumptions,
      externalEffects: input.externalEffects,
      requestedCapabilities: input.capabilities,
      scheduleSummary: workflowScheduleSummary(definition.trigger),
    },
    definition,
  );
}

function activationProposalFor(args: {
  workflow: WorkflowRevisionOutcome["workflow"];
  revision: WorkflowRevisionOutcome["revision"];
  definition: AuthorableWorkflowDefinition;
  authoringProposal: WorkflowAuthoringProposal;
  availability: Awaited<ReturnType<typeof readFreshIntegrationAvailability>>;
  timezone: IanaTimezone;
}): ActivateWorkflowInput {
  const timezone =
    args.definition.trigger.kind === "cron"
      ? (args.definition.trigger.timezone ?? args.timezone)
      : args.timezone;
  return buildWorkflowActivationProposal({
    workflowId: args.workflow.id,
    baseRevisionId: args.revision.id,
    baseContentHash: args.revision.contentHash,
    baseRowVersion: args.workflow.rowVersion,
    definition: args.definition,
    authoringProposal: args.authoringProposal,
    availability: args.availability,
    timezone,
  });
}

function uniqueCapabilities(
  capabilities: readonly WorkflowRequiredCapability[],
): WorkflowRequiredCapability[] {
  const unique = new Map<string, WorkflowRequiredCapability>();
  for (const capability of capabilities) {
    unique.set(canonicalJson(capability), capability);
  }
  return [...unique.values()];
}

async function workflowSlugForName(userId: string, name: string): Promise<string> {
  const base = slugBase(name, "workflow");
  const rows = await db()
    .select({ slug: workflows.slug })
    .from(workflows)
    .where(and(eq(workflows.userId, userId), like(workflows.slug, `${base}%`)));
  return availableSlug(base, new Set(rows.map((row) => row.slug)));
}
