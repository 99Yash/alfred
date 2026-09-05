import { db } from "@alfred/db";
import { agentDecisionTraces, agentRuns } from "@alfred/db/schemas";
import { sanitizeToolResult, type ReplyDraftResult } from "@alfred/contracts";
import { eq } from "drizzle-orm";
import { normalizeDecisionTraceKey } from "@alfred/assistant/execution";

/**
 * Durable record of one reply-drafting decision (ADR-0098).
 *
 * Inside the `reply-drafting` workflow every terminal step calls
 * `ctx.trace("reply_drafting.decision", result)` and the executor persists it
 * with the step. The post-triage gate has no step of its own — it runs inside
 * triage's `classify` step, in another module's run — so its `no_draft` verdict
 * is written here, directly, under that triage run. Both paths land in
 * `agent_decision_traces` with the same kind, so "why did Alfred not draft a
 * reply to this thread" is one SQL query regardless of where it was decided.
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

// Register the reply-drafting trace kind against execution's open registry from
// inside this module's boundary (same mechanism as triage's
// `sender-extraction-event.ts`). `ctx.trace("reply_drafting.decision", …)` now
// accepts only a `ReplyDraftResult`; execution gains no import of this module.
declare module "@alfred/assistant/execution/decision-traces" {
  interface DecisionTraceRegistry {
    "reply_drafting.decision": ReplyDraftResult;
  }
}
