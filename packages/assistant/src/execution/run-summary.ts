import { wakeConditionSchema, type WakeCondition } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, type AgentRun } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";

/**
 * The read side of one run. It lives apart from `service.ts`, so a workflow that reads a run
 * (`user-authored-brief.ts`) does not import the service that starts it.
 */
export type RunSummary = Pick<
  AgentRun,
  | "id"
  | "userId"
  | "workflowSlug"
  | "status"
  | "currentStep"
  | "attempt"
  | "brief"
  | "startedAt"
  | "endedAt"
  | "lastCheckpointAt"
  | "cancellationGeneration"
  | "output"
  | "error"
> & { wakeCondition: WakeCondition | null };

export async function getRun(runId: string, userId: string): Promise<RunSummary | null> {
  const rows = await db()
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      workflowSlug: agentRuns.workflowSlug,
      status: agentRuns.status,
      currentStep: agentRuns.currentStep,
      attempt: agentRuns.attempt,
      brief: agentRuns.brief,
      startedAt: agentRuns.startedAt,
      endedAt: agentRuns.endedAt,
      lastCheckpointAt: agentRuns.lastCheckpointAt,
      wakeCondition: agentRuns.wakeCondition,
      cancellationGeneration: agentRuns.cancellationGeneration,
      output: agentRuns.output,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));

  const row = rows[0];

  if (!row) return null;

  return { ...row, wakeCondition: wakeConditionSchema.nullable().parse(row.wakeCondition) };
}
