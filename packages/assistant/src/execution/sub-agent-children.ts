/**
 * The children of a parent run and the outcome of each (ADR-0073). Apart from `sub-agents.ts`,
 * so the join can read children without importing the run service, which imports the workflows.
 */

import { db } from "@alfred/db";
import { agentRuns, type AgentRun } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { AWAIT_SUB_AGENT_CEILING_MS } from "./sub-agent-join-wake-queue";
import { readSubAgentMetadata, subAgentParentRunIdMatches } from "./sub-agent-metadata";

export interface ChildRunOutcome {
  ok: boolean;
  /** The child is terminal. */
  done: boolean;
  status: string;
  output?: unknown;
  error?: unknown;
  /** Checked against the join wait ceiling. */
  runningMs?: number | undefined;
  reason?: string;
}

const TERMINAL_CHILD_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalChildStatus(status: string): boolean {
  return TERMINAL_CHILD_STATUSES.has(status);
}

/**
 * Do not park when the child is terminal, unreadable, or past the wait ceiling; a re-park there
 * could loop forever.
 */
export function shouldResolveWithoutParking(outcome: ChildRunOutcome): boolean {
  return (
    outcome.done ||
    !outcome.ok ||
    (outcome.runningMs !== undefined && outcome.runningMs > AWAIT_SUB_AGENT_CEILING_MS)
  );
}

/** The columns a child's outcome is built from. Both child reads select these. */
const childOutcomeColumns = {
  status: agentRuns.status,
  output: agentRuns.output,
  error: agentRuns.error,
  metadata: agentRuns.metadata,
  startedAt: agentRuns.startedAt,
} as const;

type ChildOutcomeRow = Pick<AgentRun, keyof typeof childOutcomeColumns>;

function toChildRunOutcome(child: ChildOutcomeRow, parentRunId: string): ChildRunOutcome {
  const sub = readSubAgentMetadata(child.metadata);

  if (!sub || sub.parentRunId !== parentRunId) {
    return { ok: false, done: false, status: child.status, reason: "not_your_sub_agent" };
  }

  const done = TERMINAL_CHILD_STATUSES.has(child.status);
  const startedMs = child.startedAt ? child.startedAt.getTime() : null;

  return {
    ok: true,
    done,
    status: child.status,
    output: done ? (child.output ?? null) : undefined,
    error: done ? (child.error ?? null) : undefined,
    runningMs: !done && startedMs !== null ? Date.now() - startedMs : undefined,
  };
}

export interface SpawnedChildRun {
  id: string;
  parentRunId: string;
  outcome: ChildRunOutcome;
}

/**
 * Every child the run spawned, terminal or not, so a chat turn cannot end with children still
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
