import { isTerminalStatus } from "@alfred/contracts";
import { AppError } from "@alfred/contracts/app-errors";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { createRun } from "./service";
import type { AgentDbExecutor } from "./registry";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { enqueueRun } from "./queue";
import type { SpawnSubAgentRequest } from "@alfred/assistant/tool-runtime";
import {
  readSubAgentMetadata,
  type SubAgentMetadata,
  SUB_AGENT_WORKFLOW_SLUG,
  subAgentParentRunIdMatches,
} from "./sub-agent-metadata";

const existingSubAgentSelection = {
  id: agentRuns.id,
  status: agentRuns.status,
} as const;

export async function spawnSubAgent(args: SpawnSubAgentRequest): Promise<{
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

      if (isTerminalStatus(parent.status)) {
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
        } satisfies SubAgentMetadata,
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

  // After commit, so the worker can see the row. `once`: a retried spawn of the same child adds
  // nothing while the first job is kept.
  await enqueueRun(spawn.childRunId, { once: true });

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
