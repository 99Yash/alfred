import { db } from "@alfred/db";
import { actionStagings, agentRuns } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";

/**
 * Close an abandoned tool call before its workflow completes. A dispatcher
 * insert can survive a failed step checkpoint, so workflow state cannot prove
 * that no approval exists. The conditional write is safe to repeat and cannot
 * change a user decision or an executed action.
 */
export async function withdrawToolCallApproval(args: {
  userId: string;
  runId: string;
  stepId: string;
  attempt: number;
  toolCallId: string;
  reason: string;
}): Promise<void> {
  const now = new Date();
  const withdrawn = await db().transaction(async (tx) => {
    // A reclaimed worker must not withdraw the current worker's approval.
    // Hold the run lease while changing the action, as cancellation does.
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.status, "running"),
          eq(agentRuns.currentStep, args.stepId),
          eq(agentRuns.attempt, args.attempt),
        ),
      )
      .for("update");
    if (!run) return [];
    return tx
      .update(actionStagings)
      .set({
        status: "rejected",
        outcome: "refused",
        rejectReason: args.reason,
        decidedAt: now,
        updatedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(
        and(
          eq(actionStagings.userId, args.userId),
          eq(actionStagings.runId, args.runId),
          eq(actionStagings.toolCallId, args.toolCallId),
          eq(actionStagings.status, "pending"),
          eq(actionStagings.requiresApproval, true),
        ),
      )
      .returning({ id: actionStagings.id });
  });
  if (withdrawn.length > 0) emitReplicachePokes([args.userId]);
  // Notification and expiry workers re-read status and skip rejected rows.
}
