/**
 * Dead-man timer for a parent parked on a sub-agent (ADR-0073), scheduling side.
 * The sweep never resumes `waiting`, so a lost `sub_agent_done` signal would strand the parent.
 * The signal is lost when the child ends before the park commits, is cancelled, or crashes.
 * This delayed job is the fast path. It lives only in Redis, so the join reconciler in the
 * worker file is the backstop: it wakes a parent whose persisted wake deadline is past.
 * The worker lives in another file to avoid an import cycle.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "@alfred/db/redis";
import { toMessage } from "@alfred/contracts";

export const SUB_AGENT_JOIN_WAKE_QUEUE_NAME = "sub-agent-join-wake";

/**
 * The dead-man delay, and the point past which a still-running child is reported, not awaited
 * again.
 * Well above a normal sub-agent run plus the reclaim window.
 */
export const AWAIT_SUB_AGENT_CEILING_MS = 6 * 60_000;

export const subAgentJoinWakeJobDataSchema = z.object({
  childRunId: z.string().min(1),
  parentRunId: z.string().min(1),
});

export type SubAgentJoinWakeJobData = z.infer<typeof subAgentJoinWakeJobDataSchema>;

let _queue: Queue<SubAgentJoinWakeJobData> | undefined;

export function subAgentJoinWakeJobId(childRunId: string): string {
  // BullMQ custom job ids cannot contain `:`.
  return `sub-agent-join-wake.${childRunId}`;
}

export function getSubAgentJoinWakeQueue(): Queue<SubAgentJoinWakeJobData> {
  if (_queue) return _queue;
  _queue = new Queue<SubAgentJoinWakeJobData>(SUB_AGENT_JOIN_WAKE_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 100, age: 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });

  return _queue;
}

export async function scheduleSubAgentJoinWakeJob(args: {
  childRunId: string;
  parentRunId: string;
  delayMs: number;
}): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    const queue = getSubAgentJoinWakeQueue();
    const jobId = subAgentJoinWakeJobId(args.childRunId);
    // `add` no-ops on an existing id, and a completed job is kept for an hour.
    // Remove a finished job so a re-park gets a live timer; leave delayed and active jobs alone.
    const existing = await queue.getJob(jobId);

    if (existing) {
      const state = await existing.getState();

      if (state === "completed" || state === "failed") {
        await existing.remove();
      }
    }

    await queue.add(
      "sub-agent-join.wake",
      { childRunId: args.childRunId, parentRunId: args.parentRunId },
      {
        delay: Math.max(0, args.delayMs),
        jobId,
      },
    );
  } catch (err) {
    console.warn(
      "[sub-agent-join] failed to schedule dead-man wake",
      args.childRunId,
      toMessage(err),
    );
  }
}

export async function closeSubAgentJoinWakeQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
