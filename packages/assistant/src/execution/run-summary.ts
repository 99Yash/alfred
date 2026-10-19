import {
  runStatusSchema,
  wakeConditionSchema,
  type RunStatus,
  type WakeCondition,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";

/**
 * The read side of one run. It lives apart from `service.ts`, so a workflow that reads a run
 * (`user-authored-brief.ts`) does not import the service that starts it.
 */
export interface RunSummary {
  id: string;
  userId: string;
  workflowSlug: string;
  status: RunStatus;
  currentStep: string;
  attempt: number;
  brief: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  lastCheckpointAt: Date | null;
  wakeCondition: WakeCondition | null;
  /** Cancel increments it (#559b). */
  cancellationGeneration: number;
  output: unknown;
  error: unknown;
}

export async function getRun(runId: string, userId: string): Promise<RunSummary | null> {
  const rows = await db()
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));

  const row = rows[0];

  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    workflowSlug: row.workflowSlug,
    status: runStatusSchema.parse(row.status),
    currentStep: row.currentStep,
    attempt: row.attempt,
    brief: row.brief,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastCheckpointAt: row.lastCheckpointAt,
    wakeCondition: wakeConditionSchema.nullable().parse(row.wakeCondition),
    cancellationGeneration: row.cancellationGeneration,
    output: row.output,
    error: row.error,
  };
}
