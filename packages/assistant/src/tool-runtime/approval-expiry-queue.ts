/**
 * Schedules approval expiry (ADR-0034), so an undecided gated row cannot park its run
 * forever. A decision removes the job. The worker is `execution/approval-expiry-worker.ts`.
 * The job is the fast path only. The worker's Postgres reconciler expires a row whose job
 * failed to schedule or was lost, so a schedule failure is logged, not returned.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "@alfred/db/redis";
import { toMessage } from "@alfred/contracts";

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
    // `add` no-ops on an existing id, and a finished job lingers for an hour. Remove a
    // finished job so a resumed re-park gets a live timer. Leave delayed and active jobs.
    const existing = await queue.getJob(jobId);

    if (existing) {
      const state = await existing.getState();

      if (state === "completed" || state === "failed") {
        await existing.remove();
      }
    }

    await queue.add(
      "approval.expire",
      { stagingId: args.stagingId, userId: args.userId },
      {
        delay: Math.max(0, args.delayMs),
        jobId,
      },
    );
  } catch (err) {
    console.warn(
      "[approvals] failed to schedule approval expiry; the reconciler will expire it",
      args.stagingId,
      toMessage(err),
    );
  }
}

export async function removeApprovalExpiryJob(stagingId: string): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    const job = await getApprovalExpiryQueue().getJob(approvalExpiryJobId(stagingId));
    await job?.remove();
  } catch (err) {
    console.warn("[approvals] failed to remove queued approval expiry", stagingId, toMessage(err));
  }
}

export async function closeApprovalExpiryQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
