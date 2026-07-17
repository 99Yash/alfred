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

/**
 * Enqueue a run for execution. Lease arbitration is at the DB layer (FOR
 * UPDATE SKIP LOCKED), so multiple jobs racing the same `runId` is safe —
 * only one will see the row to lease.
 *
 * `jobId` (ADR-0027) opts the enqueue into BullMQ's native dedup: a
 * second `add` with the same `jobId` is a no-op until the prior job is
 * removed. The cron dispatcher uses
 * `workflow.{workflowId}.scheduled.{scheduledForMs}` so a retried tick
 * never enqueues the same scheduled instant twice; one-off "Run now"
 * presses pass no `jobId` and get the default per-enqueue identity.
 *
 * BullMQ forbids `:` in custom jobIds (see
 * `bullmq/.../job.js`'s `Custom Id cannot contain :` check), so the
 * separator is `.`.
 */
export async function enqueueRun(
  runId: string,
  opts?: { delayMs?: number; jobId?: string },
): Promise<void> {
  const queue = getAgentQueue();
  await queue.add("step", { runId }, { delay: opts?.delayMs, jobId: opts?.jobId });
}

export async function closeAgentQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
