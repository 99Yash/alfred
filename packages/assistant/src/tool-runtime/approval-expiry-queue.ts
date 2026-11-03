/**
 * Schedules approval expiry (ADR-0034), so an undecided gated row cannot park its run
 * forever. A decision removes the job. The worker is `execution/approval-expiry-worker.ts`.
 * The job is the fast path only. The worker's Postgres reconciler expires a row whose job
 * failed to schedule or was lost, so a schedule failure is logged, not returned.
 */

import { z } from "zod";
import { isQueueEnabled } from "@alfred/db/redis";
import { logger } from "@alfred/logging";
import { defineQueue, keyedJob } from "@alfred/assistant/queue-jobs";

export const approvalExpiryQueue = defineQueue({
  name: "staging-expire",
  jobs: {
    /**
     * One timer per staging row: the job id is the row. A resumed re-park needs a live timer, so
     * the kind revives a finished job. An unfinished job covers it: the worker re-delays a job
     * that runs before the row's new `expires_at`. BullMQ custom job ids cannot contain `:`.
     */
    "approval.expire": keyedJob(
      z.object({
        stagingId: z.string().min(1),
        userId: z.string().min(1),
      }),
      { key: ["stagingId"], id: ({ stagingId }) => `staging-expire.${stagingId}`, revive: true },
    ),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 100, age: 60 * 60 },
    removeOnFail: { count: 200, age: 24 * 60 * 60 },
  },
});

export async function scheduleApprovalExpiryJob(args: {
  stagingId: string;
  userId: string;
  delayMs: number;
}): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    await approvalExpiryQueue.add(
      "approval.expire",
      { stagingId: args.stagingId, userId: args.userId },
      { delay: Math.max(0, args.delayMs) },
    );
  } catch (err) {
    logger.warn(
      { err, stagingId: args.stagingId },
      "[approvals] failed to schedule approval expiry; the reconciler will expire it",
    );
  }
}

export async function removeApprovalExpiryJob(stagingId: string): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    const queued = await approvalExpiryQueue.getJob("approval.expire", { stagingId });
    await queued?.remove();
  } catch (err) {
    logger.warn({ err, stagingId }, "[approvals] failed to remove queued approval expiry");
  }
}
