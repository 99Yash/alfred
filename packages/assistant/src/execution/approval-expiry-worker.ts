/**
 * Approval expiry worker (ADR-0034). A still-pending staging becomes `expired` and the parked
 * run wakes, so the boss gets an auto-expired rejection. Scheduling lives in `tool-runtime`.
 * The delayed job is the fast path. It lives only in Redis, so a failed schedule or a lost job
 * would park the run forever. A Postgres reconciler is the backstop (#367): it expires overdue
 * gated rows whose run still waits, and it starts and stops with the worker.
 */

import { db } from "@alfred/db";
import { actionStagings, agentRuns } from "@alfred/db/schemas";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { DelayedError, Worker, type Job } from "bullmq";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { createRedisConnection } from "@alfred/db/redis";
import { redeliverRun, signalRunInTx } from "./service";
import { startApprovalWaitSpan } from "./runtime-spans";
import {
  APPROVAL_EXPIRY_QUEUE_NAME,
  approvalExpiryJobDataSchema,
  removeApprovalNotificationJob,
  type ApprovalExpiryJobData,
} from "@alfred/assistant/tool-runtime";
import { toMessage } from "@alfred/contracts";
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";

/** A lost timer expires at most this late. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Rows per pass. The pending gated set is bounded by the 24h window, so one pass drains it. */
const RECONCILE_BATCH_SIZE = 100;

let _worker: Worker<ApprovalExpiryJobData> | undefined;

export interface StartApprovalExpiryWorkerOpts {
  concurrency?: number;
}

export async function startApprovalExpiryWorker(
  opts: StartApprovalExpiryWorkerOpts = {},
): Promise<void> {
  if (_worker) return;
  _worker = new Worker<ApprovalExpiryJobData>(
    APPROVAL_EXPIRY_QUEUE_NAME,
    processApprovalExpiryJob,
    {
      connection: createRedisConnection("queue"),
      concurrency: opts.concurrency ?? 1,
    },
  );
  _worker.on("error", (err) => {
    console.error("[approvals:expiry-worker] error:", err.message);
  });
  reconciler.start();
}

export async function stopApprovalExpiryWorker(): Promise<void> {
  if (!_worker) return;
  await reconciler.stop();
  await _worker.close();
  _worker = undefined;
}

async function processApprovalExpiryJob(
  job: Job<ApprovalExpiryJobData>,
): Promise<ExpireStagingResult> {
  const { stagingId, userId } = approvalExpiryJobDataSchema.parse(job.data);
  const result = await expireStaging({ stagingId, userId });

  if (result.status === "deferred") {
    await job.moveToDelayed(result.expiresAt.getTime(), job.token);
    throw new DelayedError();
  }

  return result;
}

export type ExpireStagingResult =
  | {
      status: "expired";
      stagingId: string;
      runId: string;
      enqueued: boolean;
      reason?: undefined;
    }
  | { status: "skipped"; stagingId: string; reason: string }
  | { status: "deferred"; stagingId: string; expiresAt: Date; reason?: undefined };

/** Idempotent: a row that is no longer pending returns `skipped`. */
export async function expireStaging(args: {
  stagingId: string;
  userId: string;
}): Promise<ExpireStagingResult> {
  const { stagingId, userId } = args;

  // One tx with a row lock, so a racing human decision either wins or waits.
  const outcome = await db().transaction<
    | {
        kind: "expired";
        runId: string;
        shouldEnqueue: boolean;
        startedAt: Date;
        toolName: string;
        integration: string;
        riskTier: string;
      }
    | { kind: "skipped"; reason: string }
    | { kind: "deferred"; expiresAt: Date }
  >(async (tx) => {
    const rows = await tx
      .select({
        id: actionStagings.id,
        runId: actionStagings.runId,
        status: actionStagings.status,
        requiresApproval: actionStagings.requiresApproval,
        createdAt: actionStagings.createdAt,
        toolName: actionStagings.toolName,
        integration: actionStagings.integration,
        riskTier: actionStagings.riskTier,
        expiresAt: actionStagings.expiresAt,
      })
      .from(actionStagings)
      .where(and(eq(actionStagings.id, stagingId), eq(actionStagings.userId, userId)))
      .for("update");

    const row = rows[0];

    if (!row) return { kind: "skipped", reason: "missing" };

    if (row.status !== "pending") return { kind: "skipped", reason: row.status };

    if (!row.requiresApproval) return { kind: "skipped", reason: "not_gated" };

    if (row.expiresAt && row.expiresAt.getTime() > Date.now()) {
      return { kind: "deferred", expiresAt: row.expiresAt };
    }

    // Match on the staging id alone; the wake already carries the kind (ADR-0099).
    const signalOutcome = await signalRunInTx(tx, {
      runId: row.runId,
      match: { kind: "hil", approvalId: stagingId },
    });

    // Expire only if the run is parked on this approval.
    if (signalOutcome !== "woken") {
      return { kind: "skipped", reason: `signal_${signalOutcome}` };
    }

    const now = new Date();
    await tx
      .update(actionStagings)
      .set({
        status: "expired",
        // The provider was never called (#559a).
        outcome: "refused",
        rejectReason: "auto-expired",
        decidedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(eq(actionStagings.id, row.id));

    return {
      kind: "expired",
      runId: row.runId,
      shouldEnqueue: true,
      startedAt: row.createdAt,
      toolName: row.toolName,
      integration: row.integration,
      riskTier: row.riskTier,
    };
  });

  if (outcome.kind === "skipped") return { status: "skipped", reason: outcome.reason, stagingId };

  if (outcome.kind === "deferred") {
    return { status: "deferred", stagingId, expiresAt: outcome.expiresAt };
  }

  emitReplicachePokes([userId], stagingId);
  startApprovalWaitSpan({
    runId: outcome.runId,
    startedAt: outcome.startedAt,
    toolName: outcome.toolName,
    integration: outcome.integration,
    riskTier: outcome.riskTier,
  }).end("expired", new Date());
  // So a queued notification cannot email about an expired action.
  await removeApprovalNotificationJob(stagingId);

  let enqueued = false;

  if (outcome.shouldEnqueue) {
    try {
      await redeliverRun(outcome.runId);
      enqueued = true;
    } catch (err) {
      console.warn(
        "[approvals] failed to enqueue run after expiry; resume sweep will retry",
        outcome.runId,
        toMessage(err),
      );
    }
  }

  return { status: "expired", stagingId, runId: outcome.runId, enqueued };
}

/**
 * Expire overdue gated rows whose run still waits, and return how many expired. The join keeps
 * a row whose run left `waiting` out of the batch, so it cannot starve the rest. `now` comes from
 * the app clock, the same clock `expireStaging` checks, so a row cannot loop on `deferred`.
 */
async function expireOverdueStagingsOnce(now: Date, signal: AbortSignal): Promise<number> {
  const overdue = await db()
    .select({ id: actionStagings.id, userId: actionStagings.userId })
    .from(actionStagings)
    .innerJoin(agentRuns, eq(agentRuns.id, actionStagings.runId))
    .where(
      and(
        eq(actionStagings.status, "pending"),
        eq(actionStagings.requiresApproval, true),
        lte(actionStagings.expiresAt, now),
        eq(agentRuns.status, "waiting"),
      ),
    )
    .orderBy(asc(actionStagings.expiresAt))
    .limit(RECONCILE_BATCH_SIZE);

  let expired = 0;

  for (const row of overdue) {
    if (signal.aborted) break;

    try {
      const result = await expireStaging({ stagingId: row.id, userId: row.userId });

      if (result.status === "expired") expired += 1;
    } catch (err) {
      console.warn("[approvals:expiry-reconciler] failed to expire", row.id, toMessage(err));
    }
  }

  return expired;
}

const reconciler = new PeriodicTask({
  name: "approval-expiry-reconciler",
  intervalMs: RECONCILE_INTERVAL_MS,
  // Run at boot too, so a timer lost in a Redis restart fires on the next start.
  runOnStart: true,
  pass: async (signal) => {
    const expired = await expireOverdueStagingsOnce(new Date(), signal);

    // Each one means the delayed job was lost or never scheduled.
    if (expired > 0) console.warn("[approvals:expiry-reconciler] expired", expired, "overdue");
  },
});
