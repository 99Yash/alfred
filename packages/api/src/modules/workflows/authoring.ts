import {
  canonicalJson,
  integrationFromToolName,
  isIntegrationSlug,
  isToolName,
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
import { availableSlug, slugBase } from "@alfred/contracts/slug";
import { workflowScheduleSummary } from "./scheduling";
import { readFreshIntegrationAvailability } from "@alfred/assistant/connections";
import { workflowToolCatalog, type WorkflowToolCatalog } from "../tool-runtime";
import { readWorkflowReadinessContext } from "./readiness-context";
import { resolveWorkflowCapabilities, type WorkflowReadinessProblem } from "./readiness";
import {
  createWorkflowDraft,
  reconcileWorkflowReadiness,
  reviseWorkflow,
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
  const toolCatalog = workflowToolCatalog();
  const resolution = resolveWorkflowCapabilities({
    definition: definitionFromProposal(args.input),
    requested: args.input.capabilities,
    availability,
    toolCatalog,
    gmailEventHealth,
  });
  const definition = resolution.definition;
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

    const reconciled = await reconcileWorkflowReadiness({
      userId: args.userId,
      workflow: saved.workflow,
      revisionId: saved.revision.id,
      readiness,
      target: "draft",
      tx,
    });
    if (!reconciled.ok) return reconciled;
    saved = { ...saved, workflow: reconciled.workflow };

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
              toolCatalog,
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
  toolCatalog: WorkflowToolCatalog;
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
    toolCatalog: args.toolCatalog,
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
