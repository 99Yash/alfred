import { Queue } from "bullmq";
import { db } from "@alfred/db";
import { createRedisConnection } from "@alfred/db/redis";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { getWorkflow } from "./registry";

export const AGENT_QUEUE_NAME = "agent-runs";

/**
 * BullMQ takes every job with no priority before any prioritized job, so a bulk step runs only
 * when no other step waits. Jobs of one priority keep their FIFO order.
 */
const BULK_JOB_PRIORITY = 1;

export interface AgentJobData {
  runId: string;
}

let _queue: Queue<AgentJobData> | undefined;

export function getAgentQueue(): Queue<AgentJobData> {
  if (_queue) return _queue;
  _queue = new Queue<AgentJobData>(AGENT_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
    defaultJobOptions: {
      // Job retries only; the run row owns step attempts.
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 100, age: 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });

  return _queue;
}

/**
 * Two jobs for one run are safe: the DB lease lets only one run it.
 * A `jobId` makes BullMQ drop a second `add` until the first job is removed (ADR-0027).
 * BullMQ job ids cannot contain `:`.
 */
export async function enqueueRun(
  runId: string,
  opts?: { delayMs?: number; jobId?: string },
): Promise<void> {
  const queue = getAgentQueue();
  const bulk = await isBulkRun(runId);
  await queue.add(
    "step",
    { runId },
    {
      ...(opts?.delayMs === undefined ? {} : { delay: opts.delayMs }),
      ...(opts?.jobId === undefined ? {} : { jobId: opts.jobId }),
      ...(bulk ? { priority: BULK_JOB_PRIORITY } : {}),
    },
  );
}

/** A missing row or an unregistered slug is not bulk, so the step keeps the normal order. */
async function isBulkRun(runId: string): Promise<boolean> {
  const [row] = await db()
    .select({ workflowSlug: agentRuns.workflowSlug })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  return row ? getWorkflow(row.workflowSlug)?.bulk === true : false;
}

export async function closeAgentQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
