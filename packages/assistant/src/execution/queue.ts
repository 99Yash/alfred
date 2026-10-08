import { Queue } from "bullmq";
import { createRedisConnection } from "@alfred/db/redis";

export const AGENT_QUEUE_NAME = "agent-runs";

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
  await queue.add(
    "step",
    { runId },
    {
      ...(opts?.delayMs === undefined ? {} : { delay: opts.delayMs }),
      ...(opts?.jobId === undefined ? {} : { jobId: opts.jobId }),
    },
  );
}

export async function closeAgentQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
