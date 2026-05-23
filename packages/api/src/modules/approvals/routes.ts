import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { Elysia, status, t } from "elysia";
import { emitReplicachePokes } from "../../events/replicache-events";
import { authMacro } from "../../middleware/auth";
import { cancelRun, enqueueRun, signalRun } from "../agent";
import { removeApprovalNotificationJob } from "./notification-queue";

type Decision = "approve" | "reject" | "cancel_run";

interface DecisionOutcome {
  runId: string;
  decision: Decision;
  status: "approved" | "rejected";
}

/**
 * Human-in-the-loop action approvals.
 *
 * Rows remain the source of truth in `action_stagings`; this API only records
 * the user's decision, pokes Replicache so `/approvals` drops the card, and
 * wakes or cancels the parked run.
 */
export const approvalsRoutes = new Elysia({ prefix: "/api/approvals" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app.post(
      "/:stagingId/decision",
      async ({ params, body, user }) => {
        const decision = parseDecision(body.decision);
        if (!decision) {
          return status(400, {
            message: "decision must be 'approve' | 'reject' | 'cancel_run'",
          });
        }
        const reason = body.reason?.trim();

        if ((decision === "reject" || decision === "cancel_run") && !reason) {
          return status(400, { message: "Rejecting an action requires a reason" });
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
            return { runId: row.runId, decision, status: "approved" };
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
          return { runId: row.runId, decision, status: "rejected" };
        });

        if ("notFound" in outcome) return status(404, { message: "Approval not found" });
        if ("conflict" in outcome) return status(409, { message: outcome.conflict });

        emitReplicachePokes([user.id], params.stagingId);
        await removeApprovalNotificationJob(params.stagingId);

        if (outcome.decision === "cancel_run") {
          await cancelRun({ runId: outcome.runId, reason: "cancelled_by_user" });
        } else {
          const woken = await signalRun({
            runId: outcome.runId,
            match: {
              kind: "hil",
              approvalId: params.stagingId,
              approvalKind: "action_staging",
            },
          });
          if (woken) await enqueueRun(outcome.runId);
        }

        return { ok: true, runId: outcome.runId, status: outcome.status };
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
