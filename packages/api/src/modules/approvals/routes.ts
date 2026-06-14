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
            };
          }

          let shouldEnqueue = false;
          if (decision === "cancel_run") {
            const { outcome: cancelOutcome, rejectedStagingIds } = await cancelRunInTx(tx, {
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
          return { runId: row.runId, decision, status: "rejected", shouldEnqueue };
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
              err instanceof Error ? err.message : String(err),
            );
          }
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
