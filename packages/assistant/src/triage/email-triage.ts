import { TRIAGE_WORKFLOW_SLUG, type TriageCategory } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Workflow } from "@alfred/assistant/execution";
import { triageWorkflowInputSchema, type TriageWorkflowInput } from "./workflow-input";
import {
  EMAIL_TRIAGE_INITIAL_STEP,
  emailTriageStateSchema,
  emailTriageSteps,
  type EmailTriageOperationState,
  type EmailTriageStepName,
} from "./workflow-operations";

export const emailTriageWorkflow: Workflow<
  EmailTriageOperationState,
  EmailTriageStepName,
  unknown,
  TriageWorkflowInput
> = {
  slug: TRIAGE_WORKFLOW_SLUG,
  name: "Email triage",
  description:
    "Classify an inbound Gmail message into one of ten categories and write the corresponding label back, keyed per-thread (ADR-0025).",
  trigger: { kind: "event", source: "gmail", type: "message_received" },
  // A mailbox sync starts one run per message, up to 50 in one minute in prod.
  bulk: true,
  initialStep: EMAIL_TRIAGE_INITIAL_STEP,
  // The step bodies read `z.infer` of this same schema (#1180).
  stateSchema: emailTriageStateSchema,
  inputSchema: triageWorkflowInputSchema,
  closure: { kind: "none" },
  initialState({ input: parsed }) {
    return {
      documentId: parsed.documentId,
      reason: parsed.reason,
      force: parsed.force,
    };
  },
  steps: emailTriageSteps,
};

/**
 * The latest triage verdict of each message, from the run history. A run stores `category` in its
 * state only when `classify` reaches a verdict, and that step writes the object link of the message
 * first. A skipped run (triage off, sent mail, no thread id, a missing source message, or an older
 * message in a tagged thread) stores none. Thus a message with an entry here is a message that
 * triage linked. One query for the batch.
 */
export async function readTriageVerdicts(args: {
  userId: string;
  documentIds: readonly string[];
}): Promise<Map<string, TriageCategory>> {
  const verdicts = new Map<string, TriageCategory>();

  if (args.documentIds.length === 0) return verdicts;

  const rows = await db()
    .select({ id: agentRuns.id, state: agentRuns.state })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.workflowSlug, TRIAGE_WORKFLOW_SLUG),
        inArray(sql<string>`${agentRuns.state} ->> 'documentId'`, [...args.documentIds]),
      ),
    )
    // Newest first, so the first verdict for a message is its latest one.
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id));

  for (const row of rows) {
    const parsed = emailTriageStateSchema.safeParse(row.state);

    if (!parsed.success) {
      logger.warn({ err: parsed.error, runId: row.id }, "[triage] run state does not parse");
      continue;
    }

    const { documentId, category } = parsed.data;

    if (category && !verdicts.has(documentId)) verdicts.set(documentId, category);
  }

  return verdicts;
}
