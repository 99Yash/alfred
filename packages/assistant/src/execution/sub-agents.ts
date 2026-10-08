import { isTerminalStatus, runStatusSchema } from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { createRun } from "./service";
import type { AgentDbExecutor } from "./registry";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { enqueueRun } from "./queue";
import { AWAIT_SUB_AGENT_CEILING_MS } from "./sub-agent-join-wake-queue";
import { type SpawnSubAgentInput } from "@alfred/assistant/tool-runtime";
import {
  readSubAgentMetadata,
  SUB_AGENT_WORKFLOW_SLUG,
  subAgentParentRunIdMatches,
  type SubAgentChatOrigin,
} from "./sub-agent-metadata";

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

export interface SpawnedChildRun {
  id: string;
  status: string;
}

/**
 * Every child the run spawned, terminal or not, so a chat turn cannot end with children still
 * running.
 */
export async function listSpawnedChildRuns(parentRunId: string): Promise<SpawnedChildRun[]> {
  return await db()
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(subAgentParentRunIdMatches(parentRunId));
}

/** Read a child's outcome. The child must belong to the caller, so a boss cannot await any run. */
export async function readChildRunOutcome(args: {
  parentRunId: string;
  userId: string;
  childRunId: string;
}): Promise<ChildRunOutcome> {
  const rows = await db()
    .select({
      status: agentRuns.status,
      output: agentRuns.output,
      error: agentRuns.error,
      metadata: agentRuns.metadata,
      startedAt: agentRuns.startedAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, args.childRunId), eq(agentRuns.userId, args.userId)))
    .limit(1);

  const child = rows[0];

  if (!child) {
    return { ok: false, done: false, status: "not_found", reason: "child_run_not_found" };
  }

  const sub = readSubAgentMetadata(child.metadata);

  if (!sub || sub.parentRunId !== args.parentRunId) {
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

const existingSubAgentSelection = {
  id: agentRuns.id,
  status: agentRuns.status,
} as const;

export async function spawnSubAgent(
  args: SpawnSubAgentInput & {
    parentRunId: string;
    userId: string;
    parentToolCallId: string;
    /** The parent's chat turn, if any; the child streams its tool cards there. */
    chat?: SubAgentChatOrigin | undefined;
  },
): Promise<{
  ok: true;
  status: "spawned" | "already_spawned";
  parentRunId: string;
  childRunId: string;
  subId: string;
}> {
  // Lock the parent and insert the child in one tx (#559b). A racing cancel then either
  // cascades to this child or makes the spawn see a terminal parent and refuse.
  type SubAgentSpawn = { status: "spawned" | "already_spawned"; childRunId: string };

  let spawn: SubAgentSpawn;

  try {
    spawn = await db().transaction(async (tx) => {
      const parentRows = await tx
        .select({
          id: agentRuns.id,
          userId: agentRuns.userId,
          status: agentRuns.status,
          metadata: agentRuns.metadata,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.id, args.parentRunId), eq(agentRuns.userId, args.userId)))
        .limit(1)
        .for("update");

      const parent = parentRows[0];

      if (!parent) {
        throw new Error(`[sub-agents] parent run not found: ${args.parentRunId}`);
      }

      if (readSubAgentMetadata(parent.metadata)) {
        throw new Error("[sub-agents] sub-agents cannot spawn nested sub-agents");
      }

      if (isTerminalStatus(runStatusSchema.parse(parent.status))) {
        throw new AppError("run_cancelled");
      }

      const existing = await findExistingSubAgentRun(args, tx);

      if (existing) return { status: "already_spawned" as const, childRunId: existing.id };

      const metadata = {
        allowedIntegrations: args.allowedIntegrations,
        subAgent: {
          kind: "sub_agent",
          parentRunId: args.parentRunId,
          subId: args.subId,
          parentToolCallId: args.parentToolCallId,
          ...(args.chat ? { chat: args.chat } : {}),
        },
      };

      const created = await createRun(
        {
          userId: args.userId,
          // Never the parent's slug: chat-turn cannot start from a bare brief.
          workflowSlug: SUB_AGENT_WORKFLOW_SLUG,
          brief: args.brief,
          metadata,
          trigger: { kind: "manual" },
          occurrence: {
            kind: "manual",
            requestId: `${args.parentRunId}:${args.parentToolCallId}`,
          },
        },
        tx,
      );

      return { status: "spawned" as const, childRunId: created.runId };
    });
  } catch (err) {
    // A racing spawn loses on the `dedupKey` index (#375). Re-read the winner on a new
    // connection, because the violation aborted the tx.
    if (!isUniqueViolation(err)) throw err;
    const winner = await findExistingSubAgentRun(args);

    if (!winner) throw err;
    spawn = { status: "already_spawned", childRunId: winner.id };
  }

  // After commit, so the worker can see the row.
  await enqueueRun(spawn.childRunId, {
    jobId: subAgentJobId(args.parentRunId, args.parentToolCallId),
  });

  return {
    ok: true,
    status: spawn.status,
    parentRunId: args.parentRunId,
    childRunId: spawn.childRunId,
    subId: args.subId,
  };
}

async function findExistingSubAgentRun(
  args: {
    parentRunId: string;
    userId: string;
    parentToolCallId: string;
  },
  tx?: AgentDbExecutor,
): Promise<{ id: string; status: string } | null> {
  const rows = await (tx ?? db())
    .select(existingSubAgentSelection)
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        subAgentParentRunIdMatches(args.parentRunId),
        sql`${agentRuns.metadata}->'subAgent'->>'parentToolCallId' = ${args.parentToolCallId}`,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

function subAgentJobId(parentRunId: string, toolCallId: string): string {
  return `subAgent.${parentRunId}.${toolCallId}`.replaceAll(":", ".");
}
