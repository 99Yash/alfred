/**
 * Approval expiry worker (ADR-0034). A still-pending staging becomes `expired` and the parked
 * run wakes, so the boss gets an auto-expired rejection. Scheduling lives in `tool-runtime`.
 * The delayed job is the fast path. It lives only in Redis, so a failed schedule or a lost job
 * would park the run forever. A Postgres reconciler is the backstop (#367): it expires overdue
 * gated rows whose run still waits, and it starts and stops with the worker.
 */

import { db } from "@alfred/db";
import { actionStagings, agentRuns } from "@alfred/db/schemas";
import { and, asc, eq, lte } from "drizzle-orm";
import { DelayedError } from "bullmq";
import { stagedAction, type ExpireOutcome } from "./staged-action";
import { approvalExpiryQueue } from "@alfred/assistant/tool-runtime";
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { logger } from "@alfred/logging";

/** A lost timer expires at most this late. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Rows per pass. The pending gated set is bounded by the 24h window, so one pass drains it. */
const RECONCILE_BATCH_SIZE = 100;

/**
 * Expire overdue gated rows whose run still waits, and return how many expired. The join keeps
 * a row whose run left `waiting` out of the batch, so it cannot starve the rest. `now` comes from
 * the app clock, the same clock `expire` checks, so a row cannot loop on `deferred`.
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
      const result = await stagedAction({ userId: row.userId, stagingId: row.id }).expire();

      if (result.kind === "expired") expired += 1;
    } catch (err) {
      logger.warn({ err, stagingId: row.id }, "[approvals:expiry-reconciler] failed to expire");
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
    if (expired > 0) logger.warn(`[approvals:expiry-reconciler] expired ${expired} overdue`);
  },
});

/** The `staging-expire` worker. The reconciler starts after it and stops before it closes. */
export const approvalExpiryWorker = approvalExpiryQueue.consume({
  label: "approval-expiry",
  concurrency: 1,
  handlers: {
    "approval.expire": async ({ stagingId, userId }, job): Promise<ExpireOutcome> => {
      const result = await stagedAction({ userId, stagingId }).expire();

      if (result.kind === "deferred") {
        await job.moveToDelayed(result.expiresAt.getTime(), job.token);
        throw new DelayedError();
      }

      return result;
    },
  },
  alongside: [reconciler],
});
