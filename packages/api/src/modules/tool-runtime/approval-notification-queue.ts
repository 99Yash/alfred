/**
 * Approval notification queue (m13 Phase 5e / ADR-0034) — scheduling side.
 *
 * When a gated `action_stagings` row is staged, the dispatcher schedules a
 * debounced `staging-notify:<id>` job so the user is emailed if they do not
 * decide in-app first. The decision API removes the queued job when a human
 * acts first (`removeApprovalNotificationJob`), so the common path never fires.
 *
 * This file deliberately holds ONLY the queue + scheduling helpers and imports
 * nothing outside `queue/connection` + `@alfred/contracts`, keeping
 * `tool-runtime` a 0-outgoing-edge sink: the dispatcher (`../dispatch`) and the
 * decision API (`../../modules/approvals/routes`) schedule/remove through it. The
 * worker side that renders + sends the email lives in
 * `agent/approval-notification-worker.ts`, imported only at server boot.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";
import { toMessage } from "@alfred/contracts";

export const APPROVAL_NOTIFICATION_QUEUE_NAME = "staging-notify";

export const approvalNotificationJobDataSchema = z.object({
  stagingId: z.string().min(1),
  userId: z.string().min(1),
});
export type ApprovalNotificationJobData = z.infer<typeof approvalNotificationJobDataSchema>;

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

export async function scheduleApprovalNotificationJob(args: {
  stagingId: string;
  userId: string;
  delayMs: number;
}): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled()) return "disabled";
  try {
    await getApprovalNotificationQueue().add(
      "approval.notify",
      { stagingId: args.stagingId, userId: args.userId },
      {
        delay: Math.max(0, args.delayMs),
        jobId: approvalNotificationJobId(args.stagingId),
      },
    );
    return "scheduled";
  } catch (err) {
    console.warn(
      "[approvals] failed to schedule approval notification",
      args.stagingId,
      toMessage(err),
    );
    return "failed";
  }
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
      toMessage(err),
    );
  }
}

export async function closeApprovalNotificationQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
