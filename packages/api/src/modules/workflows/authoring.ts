import {
  canonicalJson,
  integrationFromToolName,
  type ActivateWorkflowInput,
  type AuthorWorkflowInput,
  type IntegrationSlug,
  type WorkflowAuthoringProposal,
  type WorkflowRequiredCapability,
  type WorkflowRevisionDefinition,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { workflows } from "@alfred/db/schemas";
import { and, eq, like } from "drizzle-orm";
import { availableSlug, slugBase } from "../../lib/slug";
import { computeNextRunAt } from "./scheduling";
import {
  createWorkflowDraft,
  reviseWorkflow,
  type WorkflowRevisionOutcome,
  type WorkflowServiceResult,
} from "./revisions";

export interface AuthoredWorkflowOutcome extends WorkflowRevisionOutcome {
  created: boolean;
  activationProposal: ActivateWorkflowInput;
}

/** Save a chat-authored proposal as a draft and return its exact approval input. */
export async function authorWorkflowDraft(args: {
  userId: string;
  runId: string;
  timezone: string;
  input: AuthorWorkflowInput;
}): Promise<WorkflowServiceResult<AuthoredWorkflowOutcome>> {
  const definition = definitionFromProposal(args.input);
  const authoringProposal = authoringProposalFromInput(args.input);

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
    });
    if (!revised.ok) return revised;
    saved = revised;
    created = revised.created;
  } else {
    const drafted = await createWorkflowDraft({
      userId: args.userId,
      slug: await workflowSlugForName(args.userId, args.input.name),
      definition,
      authoringProposal,
      createdByRunId: args.runId,
    });
    if (!drafted.ok) return drafted;
    saved = drafted;
    created = true;
  }
  return {
    ok: true,
    workflow: saved.workflow,
    revision: saved.revision,
    created,
    activationProposal: activationProposalFor({
      workflow: saved.workflow,
      revision: saved.revision,
      definition,
      authoringProposal,
      timezone: args.timezone,
    }),
  };
}

/** Derive the exact stored execution envelope from the model-facing proposal. */
export function definitionFromProposal(input: AuthorWorkflowInput): WorkflowRevisionDefinition {
  const requiredCapabilities = uniqueCapabilities(input.capabilities);
  const allowedTools = [...new Set(requiredCapabilities.map((capability) => capability.tool))];
  const integrations = new Set<IntegrationSlug>(
    allowedTools.map((tool) => integrationFromToolName(tool)),
  );
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

function authoringProposalFromInput(input: AuthorWorkflowInput): WorkflowAuthoringProposal {
  return {
    intent: input.intent,
    assumptions: input.assumptions,
    externalEffects: input.externalEffects,
    requestedCapabilities: input.capabilities,
    ...(input.scheduleSummary ? { scheduleSummary: input.scheduleSummary } : {}),
  };
}

function activationProposalFor(args: {
  workflow: WorkflowRevisionOutcome["workflow"];
  revision: WorkflowRevisionOutcome["revision"];
  definition: WorkflowRevisionDefinition;
  authoringProposal: WorkflowAuthoringProposal;
  timezone: string;
}): ActivateWorkflowInput {
  const timezone =
    args.definition.trigger.kind === "cron"
      ? (args.definition.trigger.timezone ?? args.timezone)
      : args.timezone;
  const nextRunAt = computeNextRunAt(args.definition.trigger, { timezone });
  const summary =
    args.authoringProposal.scheduleSummary ?? scheduleSummary(args.definition.trigger);

  return {
    workflowId: args.workflow.id,
    baseRevisionId: args.revision.id,
    baseContentHash: args.revision.contentHash,
    baseRowVersion: args.workflow.rowVersion,
    definition: args.definition,
    schedule: {
      summary,
      timezone,
      ...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
    },
    capabilities: args.definition.requiredCapabilities,
    assumptions: args.authoringProposal.assumptions,
    externalEffects: args.authoringProposal.externalEffects,
  };
}

function scheduleSummary(trigger: WorkflowRevisionDefinition["trigger"]): string {
  switch (trigger.kind) {
    case "cron":
      return `Cron schedule: ${trigger.schedule}`;
    case "event":
      return "When Gmail receives a message";
    case "manual":
      return "Manual runs only";
    case "on_signal":
      return `On signal: ${trigger.name}`;
  }
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
