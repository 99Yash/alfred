/**
 * The children of a parent run and the outcome of each (ADR-0073). Apart from `sub-agents.ts`,
 * so the join can read children without importing the run service, which imports the workflows.
 */

import { isTerminalStatus, type RunStatus, type TerminalRunStatus } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, type AgentRun } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { AWAIT_SUB_AGENT_CEILING_MS } from "./sub-agent-join-wake-queue";
import { readSubAgentMetadata, subAgentParentRunIdMatches } from "./sub-agent-metadata";

/**
 * One child as the join reads it. The status is the run's own `RunStatus`, and `isTerminalStatus`
 * alone decides `ended` against `live`, so this reader keeps no status table of its own.
 *
 * - `foreign`: the row does not name this parent. The join reports it and does not park on it.
 * - `ended`: the child is terminal (`completed`, `failed`, `cancelled`, or `blocked`).
 * - `live`: the child still runs. `deadlineAt` is the one wait deadline of this child: its spawn
 *   time plus the wait ceiling. It comes from the durable row, so each park and each wake of the
 *   parent uses the same deadline, also for a child that never got its first lease.
 */
export type ChildRunOutcome =
  | { kind: "foreign"; status: RunStatus }
  | { kind: "ended"; status: TerminalRunStatus; output: unknown; error: unknown }
  | { kind: "live"; status: Exclude<RunStatus, TerminalRunStatus>; deadlineAt: Date };

/** The columns a child's outcome is built from. */
const childOutcomeColumns = {
  status: agentRuns.status,
  output: agentRuns.output,
  error: agentRuns.error,
  metadata: agentRuns.metadata,
  createdAt: agentRuns.createdAt,
} as const;

type ChildOutcomeRow = Pick<AgentRun, keyof typeof childOutcomeColumns>;

/** The wait deadline of a child: its spawn time plus the wait ceiling (ADR-0073). */
export function childJoinDeadline(spawnedAt: Date): Date {
  return new Date(spawnedAt.getTime() + AWAIT_SUB_AGENT_CEILING_MS);
}

function toChildRunOutcome(child: ChildOutcomeRow, parentRunId: string): ChildRunOutcome {
  const sub = readSubAgentMetadata(child.metadata);

  if (!sub || sub.parentRunId !== parentRunId) return { kind: "foreign", status: child.status };

  const status = child.status;

  if (isTerminalStatus(status)) {
    return { kind: "ended", status, output: child.output ?? null, error: child.error ?? null };
  }

  return { kind: "live", status, deadlineAt: childJoinDeadline(child.createdAt) };
}

export interface SpawnedChildRun {
  id: string;
  parentRunId: string;
  outcome: ChildRunOutcome;
}

/**
 * Every child the run spawned, terminal or not, so a turn cannot end with children still
 * running. One read gives each child's outcome, so the caller does not read the child again.
 */
export async function listSpawnedChildRuns(args: {
  parentRunId: string;
  userId: string;
}): Promise<SpawnedChildRun[]> {
  const rows = await db()
    .select({ id: agentRuns.id, ...childOutcomeColumns })
    .from(agentRuns)
    // `user_id` is the leading column of `agent_runs_sub_agent_parent_idx`.
    .where(and(eq(agentRuns.userId, args.userId), subAgentParentRunIdMatches(args.parentRunId)));

  return rows.map((row) => ({
    id: row.id,
    parentRunId: args.parentRunId,
    outcome: toChildRunOutcome(row, args.parentRunId),
  }));
}
