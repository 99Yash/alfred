/**
 * Schedules approval expiry (ADR-0034), so an undecided gated row cannot park its run
 * forever. A decision removes the job. The worker is `execution/approval-expiry-worker.ts`.
 * The job is the fast path only. The worker's Postgres reconciler expires a row whose job
 * failed to schedule or was lost, so a schedule failure is logged, not returned.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "@alfred/db/redis";
import { logger } from "@alfred/logging";
import { clearFinishedJob } from "@alfred/assistant/queue-jobs";

export const APPROVAL_EXPIRY_QUEUE_NAME = "staging-expire";

export const approvalExpiryJobDataSchema = z.object({
  stagingId: z.string().min(1),
  userId: z.string().min(1),
});

export type ApprovalExpiryJobData = z.infer<typeof approvalExpiryJobDataSchema>;

let _queue: Queue<ApprovalExpiryJobData> | undefined;

export function approvalExpiryJobId(stagingId: string): string {
  // BullMQ custom job ids cannot contain `:`.
  return `staging-expire.${stagingId}`;
}

export function getApprovalExpiryQueue(): Queue<ApprovalExpiryJobData> {
  if (_queue) return _queue;
  _queue = new Queue<ApprovalExpiryJobData>(APPROVAL_EXPIRY_QUEUE_NAME, {
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

export async function scheduleApprovalExpiryJob(args: {
  stagingId: string;
  userId: string;
  delayMs: number;
}): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    const queue = getApprovalExpiryQueue();
    const jobId = approvalExpiryJobId(args.stagingId);
    // A resumed re-park needs a live timer. An unfinished job covers it: the worker re-delays a
    // job that runs before the row's new `expires_at`.
    await clearFinishedJob(queue, jobId);

    await queue.add(
      "approval.expire",
      { stagingId: args.stagingId, userId: args.userId },
      {
        delay: Math.max(0, args.delayMs),
        jobId,
      },
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
    const job = await getApprovalExpiryQueue().getJob(approvalExpiryJobId(stagingId));
    await job?.remove();
  } catch (err) {
    logger.warn({ err, stagingId }, "[approvals] failed to remove queued approval expiry");
  }
}

export async function closeApprovalExpiryQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
