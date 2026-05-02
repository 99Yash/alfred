import { Queue } from "bullmq";
import { createRedisConnection } from "../../queue/connection";

export const AGENT_QUEUE_NAME = "agent-runs";

export interface AgentJobData {
  runId: string;
}

let _queue: Queue<AgentJobData> | undefined;

/** Lazy-init the singleton queue. Safe to call from any module. */
export function getAgentQueue(): Queue<AgentJobData> {
  if (_queue) return _queue;
  _queue = new Queue<AgentJobData>(AGENT_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      // BullMQ retries a failed job (the *job*, not the run-step attempt).
      // The run row is the source of truth for step-attempt retries; this
      // is just the BullMQ-level safety net for ephemeral picker errors.
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 100, age: 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });
  return _queue;
}

/** Enqueue a run for execution. Lease arbitration is at the DB layer (FOR
 *  UPDATE SKIP LOCKED), so multiple jobs racing the same runId is safe —
 *  only one will see the row to lease. We don't pass a jobId; BullMQ
 *  forbids ':' in custom ids and the natural `${runId}:${Date.now()}`
 *  shape is the easiest way to encode "one job per enqueue call." */
export async function enqueueRun(runId: string, opts?: { delayMs?: number }): Promise<void> {
  const queue = getAgentQueue();
  await queue.add("step", { runId }, { delay: opts?.delayMs });
}

export async function closeAgentQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
