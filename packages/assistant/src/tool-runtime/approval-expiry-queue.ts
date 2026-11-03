/**
 * Schedules approval expiry (ADR-0034), so an undecided gated row cannot park its run
 * forever. A decision removes the job. The worker is `execution/approval-expiry-worker.ts`.
 * The job is the fast path only. The worker's Postgres reconciler expires a row whose job
 * failed to schedule or was lost, so a schedule failure is logged, not returned.
 */

import { z } from "zod";
import { isQueueEnabled } from "@alfred/db/redis";
import { logger } from "@alfred/logging";
import { clearFinishedJob, defineQueue, job } from "@alfred/assistant/queue-jobs";

export function approvalExpiryJobId(stagingId: string): string {
  // BullMQ custom job ids cannot contain `:`.
  return `staging-expire.${stagingId}`;
}

export const approvalExpiryQueue = defineQueue({
  name: "staging-expire",
  jobs: {
    /** One timer per staging row: the job id is the row. */
    "approval.expire": job(
      z.object({
        stagingId: z.string().min(1),
        userId: z.string().min(1),
      }),
      (d) => ({ jobId: approvalExpiryJobId(d.stagingId) }),
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
    // A resumed re-park needs a live timer. An unfinished job covers it: the worker re-delays a
    // job that runs before the row's new `expires_at`.
    await clearFinishedJob(approvalExpiryQueue, approvalExpiryJobId(args.stagingId));

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
    const queued = await approvalExpiryQueue.getJob(approvalExpiryJobId(stagingId));
    await queued?.remove();
  } catch (err) {
    logger.warn({ err, stagingId }, "[approvals] failed to remove queued approval expiry");
  }
}
