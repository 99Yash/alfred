/**
 * Approval expiry queue (m13 Phase 5e / ADR-0034) — scheduling side.
 *
 * A gated `action_stagings` row that nobody ever decides would otherwise
 * park its run forever. When such a row is staged, the dispatcher sets
 * `expires_at` and schedules a delayed `staging-expire:<id>` job here
 * (mirroring the `staging-notify` debounce). The decision API removes
 * the queued job when a human acts first (`removeApprovalExpiryJob`), so
 * the common path never fires.
 *
 * This file deliberately holds ONLY the queue + scheduling helpers and
 * imports nothing from `../agent`: the dispatcher imports it, and the
 * dispatcher already sits underneath `../agent` (the agent executor calls
 * `dispatchToolCall`). The worker side that needs `signalRun`/`enqueueRun`
 * lives in `expiry-worker.ts`, imported only at server boot.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";
import { toMessage } from "@alfred/contracts";

export const APPROVAL_EXPIRY_QUEUE_NAME = "staging-expire";

export const approvalExpiryJobDataSchema = z.object({
  stagingId: z.string().min(1),
  userId: z.string().min(1),
});
export type ApprovalExpiryJobData = z.infer<typeof approvalExpiryJobDataSchema>;

let _queue: Queue<ApprovalExpiryJobData> | undefined;

export function approvalExpiryJobId(stagingId: string): string {
  // BullMQ custom job ids cannot contain `:`, so this mirrors the
  // plan's `staging-expire:<id>` logical id with a dot separator.
  return `staging-expire.${stagingId}`;
}

export function getApprovalExpiryQueue(): Queue<ApprovalExpiryJobData> {
  if (_queue) return _queue;
  _queue = new Queue<ApprovalExpiryJobData>(APPROVAL_EXPIRY_QUEUE_NAME, {
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

export async function scheduleApprovalExpiryJob(args: {
  stagingId: string;
  userId: string;
  delayMs: number;
}): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled()) return "disabled";
  try {
    const queue = getApprovalExpiryQueue();
    const jobId = approvalExpiryJobId(args.stagingId);
    // BullMQ `add` is a no-op when a job with this id already exists —
    // and `removeOnComplete.age` keeps a *completed* expiry job around for
    // up to an hour. If a crash/resume re-dispatch re-parks the same
    // staging row inside that window, the bare `add` would silently skip
    // and leave the row without a live expiry timer. Drop any lingering
    // terminal job first so the re-add always installs a fresh delayed
    // job. (A still-`delayed` job is left untouched — `add` no-ops on it,
    // which is the intended idempotency; an `active` job is mid-expiry and
    // must not be removed out from under the worker.)
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
    return "scheduled";
  } catch (err) {
    console.warn("[approvals] failed to schedule approval expiry", args.stagingId, toMessage(err));
    return "failed";
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
