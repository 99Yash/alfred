import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { emitReplicachePokes } from "../../events/replicache-events";
import { authMacro } from "../../middleware/auth";
import { BadRequestError, ConflictError, NotFoundError } from "../../middleware/errors";
import {
  cancelRunInTx,
  enqueueRun,
  signalRunInTx,
  type CancelOutcome,
  type SignalOutcome,
} from "../agent";
import { removeApprovalExpiryJob } from "./expiry-queue";
import { removeApprovalNotificationJob } from "./notification-queue";
import { startApprovalWaitSpan, type ApprovalWaitOutcome } from "../agent/runtime-spans";
import { toMessage } from "@alfred/contracts";

type Decision = "approve" | "reject" | "cancel_run";

interface DecisionOutcome {
  runId: string;
  decision: Decision;
  status: "approved" | "rejected";
  shouldEnqueue: boolean;
  /**
   * Extra gated staging rows that a `cancel_run` bulk-rejected alongside
   * `params.stagingId`. Their queued expiry/notify jobs are removed after
   * commit so they don't linger as ghost jobs in Redis.
   */
  rejectedStagingIds?: string[];
  /**
   * Parent boss run woken because a `cancel_run` cancelled a sub-agent child it
   * was joining (ADR-0073). Enqueued after commit so the boss resumes promptly.
   */
  wokenParentRunId?: string | null;
  /**
   * Approval-wait observation to emit after commit (#409). Carries the staging's
   * bounded, PII-free timing/identity so `runtime.approval.wait` spans the
   * request→decision wall-clock without re-reading the row post-commit.
   */
  approvalWait?: ApprovalWaitEmit;
}

interface ApprovalWaitEmit {
  runId: string;
  /** `action_stagings.created_at` — when approval was requested. */
  startedAt: Date;
  toolName: string;
  integration: string;
  riskTier: string;
  outcome: ApprovalWaitOutcome;
}

/**
 * Human-in-the-loop action approvals.
 *
 * Rows remain the source of truth in `action_stagings`; this API only records
 * the user's decision, pokes Replicache so `/approvals` drops the card, and
 * wakes or cancels the parked run.
 */
export const approvalsRoutes = new Elysia({ prefix: "/api/approvals", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app.post(
      "/:stagingId/decision",
      async ({ params, body, user }) => {
        const decision = parseDecision(body.decision);
        if (!decision) {
          throw new BadRequestError("decision must be 'approve' | 'reject' | 'cancel_run'");
        }
        const reason = body.reason?.trim();

        if ((decision === "reject" || decision === "cancel_run") && !reason) {
          throw new BadRequestError("Rejecting an action requires a reason");
        }

        const outcome = await db().transaction<
          DecisionOutcome | { notFound: true } | { conflict: string }
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
            .where(and(eq(actionStagings.id, params.stagingId), eq(actionStagings.userId, user.id)))
            .for("update");

          const row = rows[0];
          if (!row) return { notFound: true };
          if (!row.requiresApproval) {
            return { conflict: "Action does not require approval" };
          }
          if (row.status !== "pending") {
            return { conflict: `Action is already ${row.status}` };
          }

          const now = new Date();
          if (decision === "approve") {
            const signalOutcome = await signalRunInTx(tx, {
              runId: row.runId,
              match: {
                kind: "hil",
                approvalId: params.stagingId,
                approvalKind: "action_staging",
              },
            });
            const conflict = signalOutcomeConflict(signalOutcome);
            if (conflict) return { conflict };
            await tx
              .update(actionStagings)
              .set({
                status: "approved",
                decidedInput:
                  body.editedInput === undefined ? undefined : (body.editedInput as object),
                decidedAt: now,
                rowVersion: sql`${actionStagings.rowVersion} + 1`,
              })
              .where(eq(actionStagings.id, row.id));
            return {
              runId: row.runId,
              decision,
              status: "approved",
              shouldEnqueue: signalOutcome === "woken",
              approvalWait: approvalWaitEmit(row, "approved"),
            };
          }

          let shouldEnqueue = false;
          if (decision === "cancel_run") {
            const {
              outcome: cancelOutcome,
              rejectedStagingIds,
              wokenParentRunId,
            } = await cancelRunInTx(tx, {
              runId: row.runId,
              reason: "cancelled_by_user",
              pendingApprovalRejectReason: reason,
            });
            const conflict = cancelOutcomeConflict(cancelOutcome);
            if (conflict) return { conflict };
            return {
              runId: row.runId,
              decision,
              status: "rejected",
              shouldEnqueue,
              rejectedStagingIds,
              // If the cancelled run was itself a sub-agent child, a parent
              // boss joining it was woken in-tx — enqueue it after commit too.
              wokenParentRunId,
              approvalWait: approvalWaitEmit(row, "cancelled"),
            };
          } else {
            const signalOutcome = await signalRunInTx(tx, {
              runId: row.runId,
              match: {
                kind: "hil",
                approvalId: params.stagingId,
                approvalKind: "action_staging",
              },
            });
            const conflict = signalOutcomeConflict(signalOutcome);
            if (conflict) return { conflict };
            shouldEnqueue = signalOutcome === "woken";
          }

          await tx
            .update(actionStagings)
            .set({
              status: "rejected",
              rejectReason: reason,
              decidedAt: now,
              rowVersion: sql`${actionStagings.rowVersion} + 1`,
            })
            .where(eq(actionStagings.id, row.id));
          return {
            runId: row.runId,
            decision,
            status: "rejected",
            shouldEnqueue,
            approvalWait: approvalWaitEmit(row, "rejected"),
          };
        });

        if ("notFound" in outcome) throw new NotFoundError("Approval not found");
        if ("conflict" in outcome) throw new ConflictError(outcome.conflict);

        emitReplicachePokes([user.id], params.stagingId);
        // A `cancel_run` bulk-rejects every gated pending row on the run,
        // not just this one; tear down the queued jobs for all of them so
        // none linger as ghost jobs that fire later and no-op.
        const stagingIdsToClear = new Set<string>([
          params.stagingId,
          ...(outcome.rejectedStagingIds ?? []),
        ]);
        for (const id of stagingIdsToClear) {
          await removeApprovalNotificationJob(id);
          await removeApprovalExpiryJob(id);
        }

        let enqueued = false;
        if (outcome.shouldEnqueue) {
          try {
            await enqueueRun(outcome.runId);
            enqueued = true;
          } catch (err) {
            console.warn(
              "[approvals] failed to enqueue woken run; resume sweep will retry",
              outcome.runId,
              toMessage(err),
            );
          }
        }
        // A `cancel_run` on a sub-agent child wakes the parent boss joining it
        // (ADR-0073); resume it so the boss reads the cancelled outcome rather
        // than hanging until its dead-man timer fires.
        const wokenParentRunId = outcome.wokenParentRunId;
        if (wokenParentRunId) {
          try {
            await enqueueRun(wokenParentRunId);
          } catch (err) {
            console.warn(
              "[approvals] failed to enqueue woken parent run; dead-man timer will retry",
              wokenParentRunId,
              toMessage(err),
            );
          }
        }

        // Best-effort approval-wait span (#409): the gated action's
        // request→decision wall-clock, opened backdated to the staging's
        // createdAt and closed now. Swallowed inside the runtime-span helper.
        if (outcome.approvalWait) {
          const wait = outcome.approvalWait;
          startApprovalWaitSpan({
            runId: wait.runId,
            startedAt: wait.startedAt,
            toolName: wait.toolName,
            integration: wait.integration,
            riskTier: wait.riskTier,
          }).end(wait.outcome, new Date());
        }

        return { ok: true, runId: outcome.runId, status: outcome.status, enqueued };
      },
      {
        params: t.Object({ stagingId: t.String({ minLength: 1, maxLength: 120 }) }),
        body: t.Object({
          decision: t.String({ minLength: 1, maxLength: 32 }),
          editedInput: t.Optional(t.Unknown()),
          reason: t.Optional(t.String({ maxLength: 2_000 })),
        }),
      },
    ),
  );

function parseDecision(value: string): Decision | null {
  if (value === "approve" || value === "reject" || value === "cancel_run") return value;
  return null;
}

/** Build the after-commit approval-wait emission from the locked staging row. */
function approvalWaitEmit(
  row: { runId: string; createdAt: Date; toolName: string; integration: string; riskTier: string },
  outcome: ApprovalWaitOutcome,
): ApprovalWaitEmit {
  return {
    runId: row.runId,
    startedAt: row.createdAt,
    toolName: row.toolName,
    integration: row.integration,
    riskTier: row.riskTier,
    outcome,
  };
}

function signalOutcomeConflict(outcome: SignalOutcome): string | null {
  if (outcome === "not_found") return "Run not found";
  if (outcome === "wake_mismatch") return "Run is not waiting for this approval";
  if (outcome === "already_terminal") return "Run has already finished";
  return null;
}

function cancelOutcomeConflict(outcome: CancelOutcome): string | null {
  if (outcome === "not_found") return "Run not found";
  if (outcome === "already_terminal") return "Run has already finished";
  return null;
}
