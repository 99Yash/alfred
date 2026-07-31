import {
  canonicalJson,
  integrationFromToolName,
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
import { computeNextRunAt, workflowScheduleSummary } from "./scheduling";
import { readIntegrationAvailability } from "../integrations/availability";
import { resolveWorkflowReadiness, type WorkflowReadinessProblem } from "./readiness";
import {
  createWorkflowDraft,
  reviseWorkflow,
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
  const definition = definitionFromProposal(args.input);
  const authoringProposal = authoringProposalFromInput(args.input, definition);

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
  const readiness = resolveWorkflowReadiness({
    definition,
    availability: await readIntegrationAvailability(args.userId),
  });
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
            timezone: args.timezone,
          }),
        }
      : {}),
  };
}

/** Derive the exact stored execution envelope from the model-facing proposal. */
export function definitionFromProposal(input: AuthorWorkflowInput): AuthorableWorkflowDefinition {
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

function authoringProposalFromInput(
  input: AuthorWorkflowInput,
  definition: AuthorableWorkflowDefinition,
): WorkflowAuthoringProposal {
  return {
    intent: input.intent,
    assumptions: input.assumptions,
    externalEffects: input.externalEffects,
    requestedCapabilities: input.capabilities,
    scheduleSummary: workflowScheduleSummary(definition.trigger),
  };
}

function activationProposalFor(args: {
  workflow: WorkflowRevisionOutcome["workflow"];
  revision: WorkflowRevisionOutcome["revision"];
  definition: AuthorableWorkflowDefinition;
  authoringProposal: WorkflowAuthoringProposal;
  timezone: IanaTimezone;
}): ActivateWorkflowInput {
  const timezone =
    args.definition.trigger.kind === "cron"
      ? (args.definition.trigger.timezone ?? args.timezone)
      : args.timezone;
  const previewedAt = new Date();
  const nextRunAt = computeNextRunAt(args.definition.trigger, { from: previewedAt, timezone });

  return {
    workflowId: args.workflow.id,
    baseRevisionId: args.revision.id,
    baseContentHash: args.revision.contentHash,
    baseRowVersion: args.workflow.rowVersion,
    definition: args.definition,
    schedule: {
      summary: workflowScheduleSummary(args.definition.trigger),
      timezone,
      previewedAt: previewedAt.toISOString(),
      ...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
    },
    authoringProposal: args.authoringProposal,
  };
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
