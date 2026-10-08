import { db } from "@alfred/db";
import { agentDecisionTraces, agentRuns } from "@alfred/db/schemas";
import { sanitizeToolResult, type ReplyDraftResult } from "@alfred/contracts";
import { eq } from "drizzle-orm";
import { normalizeDecisionTraceKey } from "@alfred/assistant/execution";

/**
 * Durable record of a reply-drafting decision (ADR-0098). The workflow traces it per step;
 * the post-triage gate has no step, so its `no_draft` is written here under the triage run.
 * Both land in `agent_decision_traces` with one kind, so one query answers "why no draft".
 */
export const REPLY_DRAFT_DECISION_TRACE_KIND = "reply_drafting.decision";

export async function recordReplyDraftDecision(args: {
  userId: string;
  runId: string;
  stepId: string;
  attempt: number;
  result: ReplyDraftResult;
}): Promise<void> {
  const runRows = await db()
    .select({ userId: agentRuns.userId, workflowSlug: agentRuns.workflowSlug })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);

  const run = runRows[0];

  if (!run) throw new Error(`[reply-drafting] decision trace run not found: ${args.runId}`);

  if (run.userId !== args.userId) {
    throw new Error(
      `[reply-drafting] decision trace run mismatch for run=${args.runId} user=${args.userId}`,
    );
  }

  await db()
    .insert(agentDecisionTraces)
    .values({
      runId: args.runId,
      userId: run.userId,
      workflowSlug: run.workflowSlug,
      stepId: args.stepId,
      attempt: args.attempt,
      kind: REPLY_DRAFT_DECISION_TRACE_KIND,
      decisionKey: normalizeDecisionTraceKey(
        args.result.provenance.inbound.sourceThreadId ?? undefined,
      ),
      trace: sanitizeToolResult(args.result).value,
    })
    .onConflictDoNothing();
}

// Register the trace kind from this module, like triage's `sender-extraction-event.ts`,
// so execution needs no import of it.
declare module "@alfred/assistant/execution/decision-traces" {
  interface DecisionTraceRegistry {
    "reply_drafting.decision": ReplyDraftResult;
  }
}
