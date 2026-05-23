import { Queue } from "bullmq";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";

export const APPROVAL_NOTIFICATION_QUEUE_NAME = "staging-notify";

export interface ApprovalNotificationJobData {
  stagingId: string;
  userId: string;
}

let _queue: Queue<ApprovalNotificationJobData> | undefined;

export function approvalNotificationJobId(stagingId: string): string {
  // BullMQ custom job ids cannot contain `:`, so this mirrors the
  // plan's `staging-notify:<id>` logical id with a dot separator.
  return `staging-notify.${stagingId}`;
}

export function getApprovalNotificationQueue(): Queue<ApprovalNotificationJobData> {
  if (_queue) return _queue;
  _queue = new Queue<ApprovalNotificationJobData>(APPROVAL_NOTIFICATION_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 100, age: 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });
  return _queue;
}

export async function removeApprovalNotificationJob(stagingId: string): Promise<void> {
  if (!isQueueEnabled()) return;
  try {
    const job = await getApprovalNotificationQueue().getJob(approvalNotificationJobId(stagingId));
    await job?.remove();
  } catch (err) {
    console.warn(
      "[approvals] failed to remove queued approval notification",
      stagingId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function closeApprovalNotificationQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
