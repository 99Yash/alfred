import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { authMacro } from "./middleware/auth";
import {
  redeliverRun,
  signalRunInTx,
  type CancelOutcome,
  type SignalOutcome,
} from "@alfred/assistant/execution";
import { cancelRunInTx } from "@alfred/assistant/execution/service";
import {
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
  scheduleApprovalExpiryJob,
} from "@alfred/assistant/tool-runtime";
import {
  startApprovalWaitSpan,
  type ApprovalWaitOutcome,
} from "@alfred/assistant/execution/runtime-spans";
import {
  askUserDecidedInput,
  Errors,
  isQuestionApproval,
  jsonValueSchema,
  toMessage,
} from "@alfred/contracts";
import {
  prepareWorkflowApprovalEdit,
  restageWorkflowApproval,
  type WorkflowApprovalEditPreparation,
} from "@alfred/assistant/automation";
import { requireOnboarded } from "./middleware/onboarding";

type Decision = "approve" | "reject" | "cancel_run";

const CANCEL_RUN_REASON = "cancelled_by_user";

interface DecisionOutcome {
  runId: string;
  decision: Decision;
  status: "approved" | "rejected";
  shouldEnqueue: boolean;
  /** Set only by a real `cancel_run`. Run it after commit. Never throws. */
  cancelAfterCommit?: () => Promise<void>;
  /** Emitted after commit, so the span needs no second row read. */
  approvalWait?: ApprovalWaitEmit;
}

interface RefreshedOutcome {
  runId: string;
  status: "pending";
  refreshed: true;
  expiresAt: Date;
}

interface ApprovalWaitEmit {
  runId: string;
  startedAt: Date;
  toolName: string;
  integration: string;
  riskTier: string;
  outcome: ApprovalWaitOutcome;
}

/** Records a decision on an `action_stagings` row, then wakes or cancels the parked run. */
export const approvalsRoutes = new Elysia({ prefix: "/api/approvals", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app.post(
      "/:stagingId/decision",
      async ({ params, body, user }) => {
        const decision = parseDecision(body.decision);

        if (!decision) {
          throw Errors.BadRequestError("decision must be 'approve' | 'reject' | 'cancel_run'");
        }

        const reason = body.reason?.trim();

        const editedInput =
          body.editedInput === undefined ? undefined : jsonValueSchema.parse(body.editedInput);

        // The plain-reject check needs the locked row, so it runs below.
        if (decision === "cancel_run" && !reason) {
          throw Errors.BadRequestError("Rejecting an action requires a reason");
        }

        // Read outside the transaction, so the row lock stays short.
        let workflowEdit: WorkflowApprovalEditPreparation = { kind: "not_workflow" };

        if (decision === "approve") {
          workflowEdit = await prepareWorkflowApprovalEdit({
            userId: user.id,
            stagingId: params.stagingId,
            expectedRowVersion: body.expectedRowVersion,
            editedInput,
          });

          if (workflowEdit.kind === "invalid") {
            throw Errors.BadRequestError(workflowEdit.message);
          }
        }

        const outcome = await db().transaction<
          | DecisionOutcome
          | RefreshedOutcome
          | { notFound: true }
          | { conflict: string }
          | { badRequest: string }
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
              rowVersion: actionStagings.rowVersion,
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

          if (row.rowVersion !== body.expectedRowVersion) {
            return { conflict: "The approval changed. Review the latest contract." };
          }

          // A question needs no reason: dismissal is the answer (ADR-0099).
          if (decision === "reject" && !reason && !isQuestionApproval(row.toolName)) {
            return { badRequest: "Rejecting an action requires a reason" };
          }

          const now = new Date();

          if (decision === "approve") {
            // Validate answers here, so a bad answer list is a 400 on the card (ADR-0099).
            if (isQuestionApproval(row.toolName) && editedInput !== undefined) {
              const answered = askUserDecidedInput.safeParse(editedInput);

              if (!answered.success) {
                const issue = answered.error.issues[0];
                const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";

                return {
                  badRequest: `Answers do not fit the questions${where}: ${issue?.message ?? "invalid input"}`,
                };
              }
            }

            // An edited workflow needs a second approval of fields the user has seen.
            if (workflowEdit.kind === "prepared" && workflowEdit.requiresReview) {
              const expiresAt = await restageWorkflowApproval(tx, row.id, workflowEdit.input);

              return { runId: row.runId, status: "pending", refreshed: true, expiresAt };
            }

            // Match on the staging id alone; the wake already carries the kind (ADR-0099).
            const signalOutcome = await signalRunInTx(tx, {
              runId: row.runId,
              match: { kind: "hil", approvalId: params.stagingId },
            });

            const conflict = signalOutcomeConflict(signalOutcome);

            if (conflict) return { conflict };
            await tx
              .update(actionStagings)
              .set({
                status: "approved",
                // The MCP broker requires `dispatching` before it reserves an invocation.
                outcome: "dispatching",
                decidedInput:
                  workflowEdit.kind === "prepared"
                    ? jsonValueSchema.parse(workflowEdit.input)
                    : editedInput,
                decidedAt: now,
                rowVersion: sql`${actionStagings.rowVersion} + 1`,
              })
              .where(eq(actionStagings.id, row.id));

            return {
              runId: row.runId,
              decision,
              status: "approved",
              shouldEnqueue: signalOutcome === "woken",
              approvalWait: approvalWaitEmit(
                row,
                isQuestionApproval(row.toolName) ? "answered" : "approved",
              ),
            };
          }

          let shouldEnqueue = false;

          if (decision === "cancel_run") {
            const { outcome: cancelOutcome, afterCommit } = await cancelRunInTx(tx, {
              runId: row.runId,
              reason: CANCEL_RUN_REASON,
              pendingApprovalRejectReason: reason,
            });

            const conflict = cancelOutcomeConflict(cancelOutcome);

            if (conflict) return { conflict };

            return {
              runId: row.runId,
              decision,
              status: "rejected",
              shouldEnqueue,
              cancelAfterCommit: afterCommit,
              approvalWait: approvalWaitEmit(row, "cancelled"),
            };
          } else {
            const signalOutcome = await signalRunInTx(tx, {
              runId: row.runId,
              match: { kind: "hil", approvalId: params.stagingId },
            });

            const conflict = signalOutcomeConflict(signalOutcome);

            if (conflict) return { conflict };
            shouldEnqueue = signalOutcome === "woken";
          }

          await tx
            .update(actionStagings)
            .set({
              status: "rejected",
              // `refused`, not `failed`: the provider was never called.
              outcome: "refused",
              rejectReason: reason ?? null,
              decidedAt: now,
              rowVersion: sql`${actionStagings.rowVersion} + 1`,
            })
            .where(eq(actionStagings.id, row.id));

          return {
            runId: row.runId,
            decision,
            status: "rejected",
            shouldEnqueue,
            approvalWait: approvalWaitEmit(
              row,
              isQuestionApproval(row.toolName) ? "dismissed" : "rejected",
            ),
          };
        });

        if ("notFound" in outcome) throw Errors.NotFoundError("Approval not found");

        if ("conflict" in outcome) throw Errors.ConflictError(outcome.conflict);

        if ("badRequest" in outcome) throw Errors.BadRequestError(outcome.badRequest);

        emitReplicachePokes([user.id], params.stagingId);

        if ("refreshed" in outcome) {
          await removeApprovalExpiryJob(params.stagingId);
          await scheduleApprovalExpiryJob({
            stagingId: params.stagingId,
            userId: user.id,
            delayMs: outcome.expiresAt.getTime() - Date.now(),
          });

          return {
            ok: true,
            runId: outcome.runId,
            status: outcome.status,
            refreshed: true,
            enqueued: false,
          };
        }

        // Without it, a cancelled chat turn's streaming bubble hangs forever.
        await outcome.cancelAfterCommit?.();
        // Idempotent, so a repeat after a cancel is harmless.
        await removeApprovalNotificationJob(params.stagingId);
        await removeApprovalExpiryJob(params.stagingId);

        let enqueued = false;

        if (outcome.shouldEnqueue) {
          try {
            await redeliverRun(outcome.runId);
            enqueued = true;
          } catch (err) {
            console.warn(
              "[approvals] failed to enqueue woken run; resume sweep will retry",
              outcome.runId,
              toMessage(err),
            );
          }
        }

        // Best effort: backdated to the staging's `createdAt`, closed now.
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
          expectedRowVersion: t.Integer({ minimum: 1 }),
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

/**
 * `null` only if the run woke. `not_waiting` is a conflict: recording the decision
 * would retire the row while the gated tool call never gets the answer.
 */
function signalOutcomeConflict(outcome: SignalOutcome): string | null {
  if (outcome === "woken") return null;

  if (outcome === "not_found") return "Run not found";

  if (outcome === "not_waiting") return "Run is not waiting for an approval";

  if (outcome === "wake_mismatch") return "Run is not waiting for this approval";

  if (outcome === "already_terminal") return "Run has already finished";
  const unhandled: never = outcome;

  return unhandled;
}

function cancelOutcomeConflict(outcome: CancelOutcome): string | null {
  if (outcome === "cancelled") return null;

  if (outcome === "not_found") return "Run not found";

  if (outcome === "already_terminal") return "Run has already finished";
  const unhandled: never = outcome;

  return unhandled;
}
