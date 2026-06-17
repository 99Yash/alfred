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
