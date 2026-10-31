/**
 * Schedules the debounced approval email (ADR-0034). A decision in the app removes the job.
 * The worker is `execution/approval-notification-worker.ts`.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "@alfred/db/redis";
import { sha256Canonical } from "@alfred/db/hash";
import { logger } from "@alfred/logging";

export const APPROVAL_NOTIFICATION_QUEUE_NAME = "staging-notify";

export const approvalNotificationJobDataSchema = z.object({
  stagingId: z.string().min(1),
  userId: z.string().min(1),
  /** `approvalCardKey` of the card this job is for. Absent for a row's first card. */
  card: z.string().min(1).optional(),
});

export type ApprovalNotificationJobData = z.infer<typeof approvalNotificationJobDataSchema>;

/** One email when a workflow becomes blocked. Same queue; approval jobs carry no `kind`. */
export const workflowBlockedNotificationJobDataSchema = z.object({
  kind: z.literal("workflow_blocked"),
  workflowId: z.string().min(1),
  userId: z.string().min(1),
  /** `workflowBlockedGeneration` at enqueue. The worker sends only while it still matches. */
  generation: z.string().min(1),
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

/**
 * Which approval card of a staging row a notice is for. The first card has no key (`undefined`).
 * A may-have-run card is a new decision on the same row, so the claim that it was restaged from
 * keys it. The claim time is only an identity here: it is compared for equality, never ordered.
 * The job id, the job data, the worker's match, and the email idempotency key all use this key.
 */
export function approvalCardKey(dispatchClaimedAt: Date | null): string | undefined {
  // BullMQ custom job ids cannot contain `:`, so neither can the key.
  return dispatchClaimedAt === null ? undefined : `claim-${dispatchClaimedAt.getTime()}`;
}

/** Each card has its own id, so a may-have-run card's job never meets the first card's job. */
export function approvalNotificationJobId(stagingId: string, card?: string): string {
  const base = `staging-notify.${stagingId}`;

  return card === undefined ? base : `${base}.${card}`;
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
  /** The row's `dispatch_claimed_at`. Set only on a may-have-run card. */
  dispatchClaimedAt: Date | null;
}): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled()) return "disabled";

  const card = approvalCardKey(args.dispatchClaimedAt);

  try {
    await getApprovalNotificationQueue().add(
      "approval.notify",
      {
        stagingId: args.stagingId,
        userId: args.userId,
        ...(card === undefined ? {} : { card }),
      },
      {
        delay: Math.max(0, args.delayMs),
        jobId: approvalNotificationJobId(args.stagingId, card),
      },
    );

    return "scheduled";
  } catch (err) {
    logger.warn(
      { err, stagingId: args.stagingId },
      "[approvals] failed to schedule approval notification",
    );

    return "failed";
  }
}

/** One job per workflow and blocker generation. Hashed because BullMQ ids must be short and free of `:`. */
export function workflowBlockedNotificationJobId(args: {
  workflowId: string;
  generation: string;
}): string {
  return `workflow-blocked.${args.workflowId}.${sha256Canonical(args.generation).slice(7, 23)}`;
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
    logger.warn(
      { err, workflowId: args.workflowId },
      "[workflows] failed to schedule blocked notification",
    );

    return "failed";
  }
}

/**
 * Removes the first card's job. A may-have-run card's job can stay after a decision: the worker
 * skips it, because the row is no longer `pending` or its card key no longer matches.
 */
export async function removeApprovalNotificationJob(stagingId: string): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    const job = await getApprovalNotificationQueue().getJob(approvalNotificationJobId(stagingId));
    await job?.remove();
  } catch (err) {
    logger.warn({ err, stagingId }, "[approvals] failed to remove queued approval notification");
  }
}

export async function closeApprovalNotificationQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
