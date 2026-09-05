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
 * decision API (`@alfred/http`'s `approvals` route) schedule/remove through it. The
 * worker side that renders + sends the email lives in
 * `agent/approval-notification-worker.ts`, imported only at server boot.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "@alfred/db/redis";
import { sha256Canonical } from "@alfred/db/hash";
import { toMessage } from "@alfred/contracts";

export const APPROVAL_NOTIFICATION_QUEUE_NAME = "staging-notify";

export const approvalNotificationJobDataSchema = z.object({
  stagingId: z.string().min(1),
  userId: z.string().min(1),
});
export type ApprovalNotificationJobData = z.infer<typeof approvalNotificationJobDataSchema>;

/**
 * #561: a workflow that just became blocked owes its owner one email. It rides
 * the same queue and worker as approval notifications so no new boot wiring is
 * needed; the `kind` discriminator is what tells the worker which branch runs
 * (legacy approval jobs carry no `kind`).
 */
export const workflowBlockedNotificationJobDataSchema = z.object({
  kind: z.literal("workflow_blocked"),
  workflowId: z.string().min(1),
  userId: z.string().min(1),
  revisionId: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});
export type WorkflowBlockedNotificationJobData = z.infer<
  typeof workflowBlockedNotificationJobDataSchema
>;

export const notificationJobDataSchema = z.union([
  workflowBlockedNotificationJobDataSchema,
  approvalNotificationJobDataSchema,
]);
export type NotificationJobData = z.infer<typeof notificationJobDataSchema>;

let _queue: Queue<NotificationJobData> | undefined;

export function approvalNotificationJobId(stagingId: string): string {
  // BullMQ custom job ids cannot contain `:`, so this mirrors the
  // plan's `staging-notify:<id>` logical id with a dot separator.
  return `staging-notify.${stagingId}`;
}

export function getApprovalNotificationQueue(): Queue<NotificationJobData> {
  if (_queue) return _queue;
  _queue = new Queue<NotificationJobData>(APPROVAL_NOTIFICATION_QUEUE_NAME, {
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

/**
 * Job id keyed by workflow AND blocker generation: the same blocker never
 * enqueues twice while its job is still known to BullMQ, but a new code,
 * message, or revision does.
 */
export function workflowBlockedNotificationJobId(args: {
  workflowId: string;
  revisionId: string;
  code: string;
  message: string;
}): string {
  const generation = sha256Canonical({
    code: args.code,
    message: args.message,
    revisionId: args.revisionId,
  }).slice(7, 23);
  return `workflow-blocked.${args.workflowId}.${generation}`;
}

export async function scheduleWorkflowBlockedNotificationJob(
  args: Omit<WorkflowBlockedNotificationJobData, "kind">,
): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled()) return "disabled";
  try {
    await getApprovalNotificationQueue().add(
      "workflow.blocked",
      { kind: "workflow_blocked", ...args },
      { jobId: workflowBlockedNotificationJobId(args) },
    );
    return "scheduled";
  } catch (err) {
    console.warn(
      "[workflows] failed to schedule blocked notification",
      args.workflowId,
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
