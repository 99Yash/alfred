/**
 * Dead-man timer for a parent parked on a sub-agent (ADR-0073), scheduling side.
 * The sweep never resumes `waiting`, so a lost `sub_agent_done` signal would strand the parent.
 * The signal is lost when the child ends before the park commits, is cancelled, or crashes.
 * This delayed job is the fast path. It lives only in Redis, so the join reconciler in the
 * worker file is the backstop: it wakes a parent whose persisted wake deadline is past.
 * The worker is `sub-agent-join-wake-worker.ts`, in another file to avoid an import cycle.
 */

import { z } from "zod";
import { isQueueEnabled } from "@alfred/db/redis";
import { logger } from "@alfred/logging";
import { clearFinishedJob, defineQueue, job } from "@alfred/assistant/queue-jobs";

/**
 * The dead-man delay, and the point past which a still-running child is reported, not awaited
 * again.
 * Well above a normal sub-agent run plus the reclaim window.
 */
export const AWAIT_SUB_AGENT_CEILING_MS = 6 * 60_000;

export function subAgentJoinWakeJobId(childRunId: string): string {
  // BullMQ custom job ids cannot contain `:`.
  return `sub-agent-join-wake.${childRunId}`;
}

export const subAgentJoinWakeQueue = defineQueue({
  name: "sub-agent-join-wake",
  jobs: {
    /** One timer per child: the job id is the child run. */
    "sub-agent-join.wake": job(
      z.object({
        childRunId: z.string().min(1),
        parentRunId: z.string().min(1),
      }),
      (d) => ({ jobId: subAgentJoinWakeJobId(d.childRunId) }),
    ),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 100, age: 60 * 60 },
    removeOnFail: { count: 200, age: 24 * 60 * 60 },
  },
});

export async function scheduleSubAgentJoinWakeJob(args: {
  childRunId: string;
  parentRunId: string;
  delayMs: number;
}): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    // A re-park needs a live timer. An unfinished job covers it, and the join reconciler is the
    // backstop when the wake ran too early.
    await clearFinishedJob(subAgentJoinWakeQueue, subAgentJoinWakeJobId(args.childRunId));

    await subAgentJoinWakeQueue.add(
      "sub-agent-join.wake",
      { childRunId: args.childRunId, parentRunId: args.parentRunId },
      { delay: Math.max(0, args.delayMs) },
    );
  } catch (err) {
    logger.warn(
      { err, childRunId: args.childRunId },
      "[sub-agent-join] failed to schedule dead-man wake",
    );
  }
}
