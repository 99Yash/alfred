/**
 * Approval expiry worker (m13 Phase 5e / ADR-0034) — worker side.
 *
 * When a delayed `staging-expire:<id>` job fires:
 *
 *   - re-read the row; if it is no longer `pending`, the user already
 *     decided (or it was cancelled) — no-op.
 *   - otherwise flip `status='expired'`, `reject_reason='auto-expired'`,
 *     bump `row_version` (Replicache drops the card), and `signalRun` the
 *     parked run so the executor re-dispatches and the dispatcher's
 *     `case 'expired'` synthesizes the structured auto-expired rejection
 *     back to the boss — which can then re-plan or finish.
 *
 * Lives apart from `expiry-queue.ts` because it imports `../agent`
 * (`signalRunInTx` / `enqueueRun`), which sits above the dispatcher in
 * the import graph; keeping the scheduling helpers agent-free lets the
 * dispatcher schedule expiry without forming an import cycle.
 */

import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { Worker, type Job } from "bullmq";
import { emitReplicachePokes } from "../../events/replicache-events";
import { createRedisConnection } from "../../queue/connection";
import { enqueueRun, signalRunInTx } from "../agent";
import { startApprovalWaitSpan } from "../agent/runtime-spans";
import {
  APPROVAL_EXPIRY_QUEUE_NAME,
  approvalExpiryJobDataSchema,
  type ApprovalExpiryJobData,
} from "./expiry-queue";
import { removeApprovalNotificationJob } from "./notification-queue";
import { toMessage } from "@alfred/contracts";

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
      connection: createRedisConnection(),
      concurrency: opts.concurrency ?? 1,
    },
  );
  _worker.on("error", (err) => {
    console.error("[approvals:expiry-worker] error:", err.message);
  });
}

export async function stopApprovalExpiryWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = undefined;
}

async function processApprovalExpiryJob(job: Job<ApprovalExpiryJobData>): Promise<unknown> {
  const { stagingId, userId } = approvalExpiryJobDataSchema.parse(job.data);
  return expireStaging({ stagingId, userId });
}

export interface ExpireStagingResult {
  status: "expired" | "skipped";
  stagingId: string;
  reason?: string;
  runId?: string;
  enqueued?: boolean;
}

/**
 * Core expiry transition, callable directly (the BullMQ job is a thin
 * wrapper). Idempotent: a row that is already non-pending returns
 * `{ status: 'skipped' }` without touching the run.
 */
export async function expireStaging(args: {
  stagingId: string;
  userId: string;
}): Promise<ExpireStagingResult> {
  const { stagingId, userId } = args;

  // Mirror the decision API: lock the row, signal the parked run, then
  // flip status — all in one transaction so a concurrent human decision
  // either wins (row already non-pending → we skip) or loses (we hold the
  // lock and expire). The `for update` lock serializes against
  // `POST /approvals/:id/decision`.
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
      })
      .from(actionStagings)
      .where(and(eq(actionStagings.id, stagingId), eq(actionStagings.userId, userId)))
      .for("update");

    const row = rows[0];
    if (!row) return { kind: "skipped", reason: "missing" };
    if (row.status !== "pending") return { kind: "skipped", reason: row.status };
    if (!row.requiresApproval) return { kind: "skipped", reason: "not_gated" };

    const signalOutcome = await signalRunInTx(tx, {
      runId: row.runId,
      match: { kind: "hil", approvalId: stagingId, approvalKind: "action_staging" },
    });
    // Only expire when the run is genuinely parked on this approval. A
    // terminal/mismatched run shouldn't leave a pending gated row, but if
    // it does we leave it untouched rather than racing an unrelated wake.
    if (signalOutcome !== "woken") {
      return { kind: "skipped", reason: `signal_${signalOutcome}` };
    }

    const now = new Date();
    await tx
      .update(actionStagings)
      .set({
        status: "expired",
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

  emitReplicachePokes([userId], stagingId);
  // Best-effort approval-wait span (#409): the gated action sat unanswered from
  // its request until this auto-expiry. Backdated to createdAt, closed now.
  startApprovalWaitSpan({
    runId: outcome.runId,
    startedAt: outcome.startedAt,
    toolName: outcome.toolName,
    integration: outcome.integration,
    riskTier: outcome.riskTier,
  }).end("expired", new Date());
  // The notify debounce normally fired long before expiry; remove it
  // defensively so a still-queued notification can't email about an
  // action we just expired.
  await removeApprovalNotificationJob(stagingId);

  let enqueued = false;
  if (outcome.shouldEnqueue) {
    try {
      await enqueueRun(outcome.runId);
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
