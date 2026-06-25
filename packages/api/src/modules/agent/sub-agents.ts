import { LOADABLE_INTEGRATION_SLUGS } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createRun } from "./service";
import { enqueueRun } from "./queue";
import {
  readSubAgentMetadata,
  subAgentIdSchema,
  SUB_AGENT_WORKFLOW_SLUG,
} from "./sub-agent-metadata";

export const spawnSubAgentInputSchema = z
  .object({
    subId: subAgentIdSchema,
    brief: z.string().min(1).max(8_000),
    allowedIntegrations: z.array(z.enum(LOADABLE_INTEGRATION_SLUGS)).default([]),
  })
  .strict();

export type SpawnSubAgentInput = z.infer<typeof spawnSubAgentInputSchema>;

export const awaitSubAgentInputSchema = z
  .object({
    childRunId: z.string().min(1),
  })
  .strict();

export type AwaitSubAgentInput = z.infer<typeof awaitSubAgentInputSchema>;

export interface ChildRunOutcome {
  ok: boolean;
  /** True once the child reached a terminal status (completed/failed/cancelled). */
  done: boolean;
  status: string;
  /** Present for a completed child — its run output. */
  output?: unknown;
  /** Present for a failed child — its terminal error. */
  error?: unknown;
  /** ms the child has been running, used by the await wait-ceiling. */
  runningMs?: number;
  /** Why the call could not return the child's result, if applicable. */
  reason?: string;
}

const TERMINAL_CHILD_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Read a spawned child run's real outcome for a parent that is joining it
 * (ADR-0073). Enforces ownership: the child must be a sub-agent whose
 * `parentRunId` is the caller's run, so a boss cannot await an arbitrary run.
 * Returns `done:true` with the child's `status`/`output`/`error` once terminal,
 * else `done:false` with how long it has been running (the join site decides
 * whether to park or surface a still-running result).
 */
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
  },
): Promise<{
  ok: true;
  status: "spawned" | "already_spawned";
  parentRunId: string;
  childRunId: string;
  subId: string;
}> {
  const parentRows = await db()
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      metadata: agentRuns.metadata,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, args.parentRunId), eq(agentRuns.userId, args.userId)))
    .limit(1);
  const parent = parentRows[0];
  if (!parent) {
    throw new Error(`[sub-agents] parent run not found: ${args.parentRunId}`);
  }
  if (readSubAgentMetadata(parent.metadata)) {
    throw new Error("[sub-agents] sub-agents cannot spawn nested sub-agents");
  }

  const existing = await findExistingSubAgentRun(args);
  if (existing) {
    await enqueueRun(existing.id, {
      jobId: subAgentJobId(args.parentRunId, args.parentToolCallId),
    });
    return {
      ok: true,
      status: "already_spawned",
      parentRunId: args.parentRunId,
      childRunId: existing.id,
      subId: args.subId,
    };
  }

  const metadata = {
    allowedIntegrations: args.allowedIntegrations,
    subAgent: {
      kind: "sub_agent",
      parentRunId: args.parentRunId,
      subId: args.subId,
      parentToolCallId: args.parentToolCallId,
    },
  };

  const created = await createRun({
    userId: args.userId,
    // Sub-agents always run the sub-agent-aware brief workflow — never the
    // parent's own slug, which may be thread-coupled (chat-turn) and unable to
    // initialize from a bare brief. For boss / authored parents this is the
    // same workflow they already resolve to, so behavior is unchanged there.
    workflowSlug: SUB_AGENT_WORKFLOW_SLUG,
    brief: args.brief,
    metadata,
    trigger: { kind: "manual" },
  });
  await enqueueRun(created.runId, {
    jobId: subAgentJobId(args.parentRunId, args.parentToolCallId),
  });
  return {
    ok: true,
    status: "spawned",
    parentRunId: args.parentRunId,
    childRunId: created.runId,
    subId: args.subId,
  };
}

async function findExistingSubAgentRun(args: {
  parentRunId: string;
  userId: string;
  parentToolCallId: string;
}): Promise<{ id: string; status: string } | null> {
  const rows = await db()
    .select(existingSubAgentSelection)
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        sql`${agentRuns.metadata}->'subAgent'->>'parentRunId' = ${args.parentRunId}`,
        sql`${agentRuns.metadata}->'subAgent'->>'parentToolCallId' = ${args.parentToolCallId}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function subAgentJobId(parentRunId: string, toolCallId: string): string {
  return `subAgent.${parentRunId}.${toolCallId}`.replaceAll(":", ".");
}
