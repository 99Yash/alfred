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

/** Programmatic reason stamped on `agent_runs.error.reason` by a `cancel_run`. */
const CANCEL_RUN_REASON = "cancelled_by_user";

interface DecisionOutcome {
  runId: string;
  decision: Decision;
  status: "approved" | "rejected";
  shouldEnqueue: boolean;
  /**
   * Set only by a `cancel_run` that actually cancelled: every obligation the
   * cancel accrued that must not survive a rollback — workflow closure, ghost
   * staging-job teardown, scratch snapshot, a woken parent boss. `cancelRunInTx`
   * builds it; this route only has to run it once the tx commits. Never throws.
   */
  cancelAfterCommit?: () => Promise<void>;
  /**
   * Approval-wait observation to emit after commit (#409). Carries the staging's
   * bounded, PII-free timing/identity so `runtime.approval.wait` spans the
   * request→decision wall-clock without re-reading the row post-commit.
   */
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

        // The plain-reject reason rule needs the locked row (a question needs
        // none, see below); the cancel rule does not.
        if (decision === "cancel_run" && !reason) {
          throw Errors.BadRequestError("Rejecting an action requires a reason");
        }

        // Canonicalization reads workflow and integration state. Keep those
        // reads outside the decision transaction so the row lock covers only
        // the atomic staging update or run wake.
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

          // A rejection reason is the revision note the model reads back. A
          // question has no revision: dismissing it IS the answer (ADR-0099),
          // so the user is not made to invent a reason to skip it.
          if (decision === "reject" && !reason && !isQuestionApproval(row.toolName)) {
            return { badRequest: "Rejecting an action requires a reason" };
          }

          const now = new Date();
          if (decision === "approve") {
            // A question's edited input is the whole tool input with the
            // user's `answers` filled in. Validate it here, so a wrong-length
            // answer list is a 400 the card shows, not a failed row and a
            // generic `tool_input_invalid` the model re-asks past (ADR-0099).
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
            // Workflow activation edits change the exact unattended contract.
            // Rebuild the full card and require a second approval instead of
            // waking the run with fields the user did not see.
            if (workflowEdit.kind === "prepared" && workflowEdit.requiresReview) {
              const expiresAt = await restageWorkflowApproval(tx, row.id, workflowEdit.input);
              return { runId: row.runId, status: "pending", refreshed: true, expiresAt };
            }
            // Match on the staging id alone: the wake already carries the kind
            // the dispatcher wrote, and a kind re-derived here could only
            // disagree with it (ADR-0099).
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
              // The effect dimension, orthogonal to `status` (#559a). The gate
              // never called the provider, so the effect is `refused` — not
              // `failed`, which counts as an attempt. The sibling writer
              // `withdrawToolCallApproval` already states it; a row rejected
              // through this route used to keep `awaiting_approval` forever.
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
        // Everything a `cancel_run` owes once its tx lands: the workflow's
        // client closure (chat-turn has to persist its assistant row and emit
        // `chat.message completed` or the streaming bubble hangs forever —
        // #530/#531 review, D2), teardown of every gated staging the cancel
        // bulk-rejected, the scratch snapshot, and a woken parent boss. Built
        // by `cancelRunInTx` so this route can't fall behind the list; it
        // never throws, so it can't fail a decision the user already made.
        await outcome.cancelAfterCommit?.();
        // This route's own staging, on the plain-`reject` path where no cancel
        // ran. Idempotent, so the cancel path re-clearing it above is harmless.
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

/**
 * Map a wake attempt to the conflict message the decision route reports, or
 * `null` when the run really did wake.
 *
 * `not_waiting` is a conflict, not a success. It says the run is alive but is
 * parked on nothing — it never reached this approval, or another writer has
 * already woken it. Recording the decision anyway retires the staged row while
 * the run keeps running, and the tool call it gates never receives the answer.
 * The expiry worker refuses the same case for the same reason
 * (`approval-expiry-worker.ts`, `signalOutcome !== "woken"`), so both writers
 * now agree on what a decided approval means.
 */
function signalOutcomeConflict(outcome: SignalOutcome): string | null {
  if (outcome === "woken") return null;
  if (outcome === "not_found") return "Run not found";
  if (outcome === "not_waiting") return "Run is not waiting for an approval";
  if (outcome === "wake_mismatch") return "Run is not waiting for this approval";
  if (outcome === "already_terminal") return "Run has already finished";
  // A new outcome fails to compile here rather than silently reading as a
  // successful wake.
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
