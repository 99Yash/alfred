/**
 * The one owner of a staged action's state transition (ADR-0034). A staged action is a tool call
 * held in `action_stagings` for a human decision while its run waits on it.
 * `stagedAction({ userId, stagingId })` has two verbs: `decide` for the user's answer and `expire`
 * for the 24h timer. Each verb locks the run and then the staging, checks the row, writes the new
 * status, wakes or cancels the run in the same transaction, and does the after-commit work itself.
 * The caller maps the closed outcome to HTTP or to a job result.
 */

import { db, type DbTransaction } from "@alfred/db";
import { actionStagings, agentRuns, type ActionStaging } from "@alfred/db/schemas";
import {
  APPROVAL_EXPIRY_MS,
  askUserDecidedInput,
  isQuestionApproval,
  type JsonValue,
} from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import {
  removeApprovalExpiryJob,
  removeApprovalNotificationJob,
  scheduleApprovalExpiryJob,
} from "@alfred/assistant/tool-runtime";
import { cancelRunInTx, wakeRunInTx, type SignalOutcome } from "./service";
import { startApprovalWaitSpan, type ApprovalWaitOutcome } from "./runtime-spans";

/** Stored in `agent_runs.error.reason` when the user ends the run from an approval card. */
const CANCEL_RUN_REASON = "cancelled_by_user";

/** The revised proposal of an edited card that the user must review again. */
export type StagedRevision = Pick<
  ActionStaging,
  "proposedInput" | "displayInput" | "proposedInputHash"
>;

/** What an approval writes. The automation module builds it before the lock. */
export type StagedApproval =
  /** Approve the proposal, or the user's edit of it. */
  | { kind: "decide"; decidedInput: JsonValue | undefined }
  /** Keep the action pending with a revised proposal and a new expiry. */
  | { kind: "restage"; revision: StagedRevision };

export type StagedActionDecision =
  | { decision: "approve"; expectedRowVersion: number; approval: StagedApproval }
  /** A question can be dismissed with no reason (ADR-0099). Every other reject needs one. */
  | { decision: "reject"; expectedRowVersion: number; reason: string | undefined }
  /** Reject the action and cancel its run. */
  | { decision: "cancel_run"; expectedRowVersion: number; reason: string };

/** Why a verb left the staging unchanged. */
export type StagedActionRefusal =
  /** No staging with this id belongs to this user. */
  | { refusal: "not_found" }
  | { refusal: "not_gated" }
  | { refusal: "already_decided"; status: ActionStaging["status"] }
  /** The user decided on an older version of the card. */
  | { refusal: "stale_version" }
  /** The run cannot take this answer, so recording it would strand the gated tool call. */
  | { refusal: "run_unavailable"; run: Exclude<SignalOutcome, "woken"> };

/** The staging is unchanged and nothing ran after commit. */
interface Refused<R extends StagedActionRefusal = StagedActionRefusal> {
  kind: "refused";
  reason: R;
}

export type DecideOutcome =
  | Refused
  /** The input does not fit the action, such as a reject with no reason. */
  | { kind: "invalid"; message: string }
  | { kind: "decided"; runId: string; status: "approved" | "rejected"; enqueued: boolean }
  | { kind: "restaged"; runId: string };

export type ExpireOutcome =
  | Refused<Exclude<StagedActionRefusal, { refusal: "stale_version" }>>
  /** Not due yet. The job must run again at `expiresAt`. */
  | { kind: "deferred"; expiresAt: Date }
  | { kind: "expired"; runId: string; enqueued: boolean };

export interface StagedAction {
  /** Record the user's decision. Idempotent: a second decision is refused as `already_decided`. */
  decide(decision: StagedActionDecision): Promise<DecideOutcome>;
  /** Expire a pending action that is due. Idempotent: a decided row is refused. */
  expire(): Promise<ExpireOutcome>;
}

interface StagedActionKey {
  userId: string;
  stagingId: string;
}

export function stagedAction(key: StagedActionKey): StagedAction {
  return {
    decide: (decision) => decideStagedAction(key, decision),
    expire: () => expireStagedAction(key),
  };
}

/** The staging columns that the expiry and decision transactions read. */
type LockedStaging = Pick<
  ActionStaging,
  | "id"
  | "runId"
  | "status"
  | "requiresApproval"
  | "dispatchClaimedAt"
  | "createdAt"
  | "toolName"
  | "integration"
  | "riskTier"
  | "expiresAt"
  | "rowVersion"
>;

interface ApprovalWaitEmit {
  row: LockedStaging;
  outcome: ApprovalWaitOutcome;
}

type DecideTxResult =
  | Refused
  | { kind: "invalid"; message: string }
  | { kind: "restaged"; runId: string; expiresAt: Date }
  | {
      kind: "decided";
      runId: string;
      status: "approved" | "rejected";
      /** Set by `approve` and `reject`. Resolves true if it enqueued the run. */
      wakeAfterCommit?: () => Promise<boolean>;
      /** Set only by `cancel_run`. Never throws. */
      cancelAfterCommit?: () => Promise<void>;
      approvalWait: ApprovalWaitEmit;
    };

async function decideStagedAction(
  key: StagedActionKey,
  input: StagedActionDecision,
): Promise<DecideOutcome> {
  const { userId, stagingId } = key;

  const outcome = await db().transaction<DecideTxResult>(async (tx) => {
    const row = await lockStagingWithRunInTx(tx, key);

    if (!row) return refused({ refusal: "not_found" });

    if (!row.requiresApproval) return refused({ refusal: "not_gated" });

    if (row.status !== "pending") {
      return refused({ refusal: "already_decided", status: row.status });
    }

    if (row.rowVersion !== input.expectedRowVersion) return refused({ refusal: "stale_version" });

    // A question needs no reason: dismissal is the answer (ADR-0099).
    if (input.decision === "reject" && !input.reason && !isQuestionApproval(row.toolName)) {
      return { kind: "invalid", message: "Rejecting an action requires a reason" };
    }

    const now = new Date();

    if (input.decision === "approve") {
      const { approval } = input;

      // Validate answers here, so a bad answer list is a 400 on the card (ADR-0099).
      if (
        approval.kind === "decide" &&
        isQuestionApproval(row.toolName) &&
        approval.decidedInput !== undefined
      ) {
        const answered = askUserDecidedInput.safeParse(approval.decidedInput);

        if (!answered.success) {
          const issue = answered.error.issues[0];
          const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";

          return {
            kind: "invalid",
            message: `Answers do not fit the questions${where}: ${issue?.message ?? "invalid input"}`,
          };
        }
      }

      // An edited workflow needs a second approval of fields the user has seen.
      if (approval.kind === "restage") {
        const expiresAt = new Date(Date.now() + APPROVAL_EXPIRY_MS);
        await tx
          .update(actionStagings)
          .set({
            ...approval.revision,
            // A may-have-run revision must still suppress the first proposal after rejection.
            proposedInputHash:
              row.dispatchClaimedAt === null ? approval.revision.proposedInputHash : undefined,
            decidedInput: null,
            expiresAt,
            rowVersion: sql`${actionStagings.rowVersion} + 1`,
          })
          .where(eq(actionStagings.id, row.id));

        return { kind: "restaged", runId: row.runId, expiresAt };
      }

      // Match on the staging id alone; the wake already carries the kind (ADR-0099).
      const wake = await wakeRunInTx(tx, {
        runId: row.runId,
        match: { kind: "hil", approvalId: stagingId },
      });

      if (wake.outcome !== "woken")
        return refused({ refusal: "run_unavailable", run: wake.outcome });
      await tx
        .update(actionStagings)
        .set({
          status: "approved",
          // The MCP broker requires `dispatching` before it reserves an invocation.
          outcome: "dispatching",
          // `undefined` leaves the column alone, so a may-have-run card keeps an earlier edit.
          decidedInput: approval.decidedInput,
          decidedAt: now,
          // "Run again" on a may-have-run card. Without this the resumed dispatch restages again.
          dispatchClaimedAt: null,
          rowVersion: sql`${actionStagings.rowVersion} + 1`,
        })
        .where(eq(actionStagings.id, row.id));

      return {
        kind: "decided",
        runId: row.runId,
        status: "approved",
        wakeAfterCommit: wake.afterCommit,
        approvalWait: { row, outcome: isQuestionApproval(row.toolName) ? "answered" : "approved" },
      };
    }

    if (input.decision === "cancel_run") {
      const { outcome: cancelOutcome, afterCommit } = await cancelRunInTx(tx, {
        runId: row.runId,
        reason: CANCEL_RUN_REASON,
        pendingApprovalRejectReason: input.reason,
      });

      if (cancelOutcome !== "cancelled") {
        return refused({ refusal: "run_unavailable", run: cancelOutcome });
      }

      return {
        kind: "decided",
        runId: row.runId,
        status: "rejected",
        cancelAfterCommit: afterCommit,
        approvalWait: { row, outcome: "cancelled" },
      };
    }

    const wake = await wakeRunInTx(tx, {
      runId: row.runId,
      match: { kind: "hil", approvalId: stagingId },
    });

    if (wake.outcome !== "woken") return refused({ refusal: "run_unavailable", run: wake.outcome });
    await tx
      .update(actionStagings)
      .set({
        status: "rejected",
        // `refused`, not `failed`: the decided call never reached the provider. On a may-have-run
        // card, `dispatch_claimed_at` records the earlier attempt that may have.
        outcome: "refused",
        rejectReason: input.reason ?? null,
        decidedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(eq(actionStagings.id, row.id));

    return {
      kind: "decided",
      runId: row.runId,
      status: "rejected",
      wakeAfterCommit: wake.afterCommit,
      approvalWait: { row, outcome: isQuestionApproval(row.toolName) ? "dismissed" : "rejected" },
    };
  });

  if (outcome.kind === "refused" || outcome.kind === "invalid") return outcome;

  emitReplicachePokes([userId], stagingId);

  if (outcome.kind === "restaged") {
    await removeApprovalExpiryJob(stagingId);
    await scheduleApprovalExpiryJob({
      stagingId,
      userId,
      delayMs: outcome.expiresAt.getTime() - Date.now(),
    });

    return { kind: "restaged", runId: outcome.runId };
  }

  // Without it, a cancelled chat turn's streaming bubble hangs forever.
  await outcome.cancelAfterCommit?.();
  // Idempotent, so a repeat after a cancel is harmless.
  await removeApprovalNotificationJob(stagingId);
  await removeApprovalExpiryJob(stagingId);
  const enqueued = (await outcome.wakeAfterCommit?.()) ?? false;
  endApprovalWaitSpan(outcome.approvalWait);

  return { kind: "decided", runId: outcome.runId, status: outcome.status, enqueued };
}

type ExpireTxResult =
  | Exclude<ExpireOutcome, { kind: "expired" }>
  | { kind: "expired"; row: LockedStaging; wakeAfterCommit: () => Promise<boolean> };

async function expireStagedAction(key: StagedActionKey): Promise<ExpireOutcome> {
  const { userId, stagingId } = key;

  // One tx with the run and staging locks, so a racing human decision either wins or waits.
  const outcome = await db().transaction<ExpireTxResult>(async (tx) => {
    const row = await lockStagingWithRunInTx(tx, key);

    if (!row) return refused({ refusal: "not_found" });

    if (row.status !== "pending") {
      return refused({ refusal: "already_decided", status: row.status });
    }

    if (!row.requiresApproval) return refused({ refusal: "not_gated" });

    if (row.expiresAt && row.expiresAt.getTime() > Date.now()) {
      return { kind: "deferred", expiresAt: row.expiresAt };
    }

    // Match on the staging id alone; the wake already carries the kind (ADR-0099).
    const wake = await wakeRunInTx(tx, {
      runId: row.runId,
      match: { kind: "hil", approvalId: stagingId },
    });

    // Expire only if the run is parked on this approval.
    if (wake.outcome !== "woken") return refused({ refusal: "run_unavailable", run: wake.outcome });

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

    return { kind: "expired", row, wakeAfterCommit: wake.afterCommit };
  });

  if (outcome.kind !== "expired") return outcome;

  emitReplicachePokes([userId], stagingId);
  endApprovalWaitSpan({ row: outcome.row, outcome: "expired" });
  // So a queued notification cannot email about an expired action.
  await removeApprovalNotificationJob(stagingId);
  const enqueued = await outcome.wakeAfterCommit();

  return { kind: "expired", runId: outcome.row.runId, enqueued };
}

function refused<R extends StagedActionRefusal>(reason: R): Refused<R> {
  return { kind: "refused", reason };
}

/** Best effort: backdated to the staging's `createdAt`, closed now. */
function endApprovalWaitSpan({ row, outcome }: ApprovalWaitEmit): void {
  startApprovalWaitSpan({
    runId: row.runId,
    startedAt: row.createdAt,
    toolName: row.toolName,
    integration: row.integration,
    riskTier: row.riskTier,
  }).end(outcome, new Date());
}

/**
 * Lock the run that owns a staging, then the staging row itself.
 * Lock order is `agent_runs` then `action_stagings`, the same as `cancelRunInTx` and `withStepLease`.
 * An FK INSERT into a child of `agent_runs` also locks the run (`KEY SHARE`), with no visible
 * `.for(...)`, so a tx that locks a staging and then inserts such a child must lock the run first.
 * The run row stays locked until commit. Do not call a helper that opens its own transaction on
 * this run (`withStepLease`, `wakeRun`, `cancelRun`): Postgres cannot see a wait across two
 * connections, so the request hangs.
 * Returns null when the staging does not exist for this user.
 */
async function lockStagingWithRunInTx(
  tx: DbTransaction,
  args: StagedActionKey,
): Promise<LockedStaging | null> {
  const owned = and(eq(actionStagings.id, args.stagingId), eq(actionStagings.userId, args.userId));

  const runs = await tx
    .select({ id: agentRuns.id })
    .from(actionStagings)
    .innerJoin(agentRuns, eq(agentRuns.id, actionStagings.runId))
    .where(owned)
    .for("update", { of: agentRuns });

  if (!runs[0]) return null;

  // `run_id` never changes, so this row belongs to the run locked above.
  const rows = await tx
    .select({
      id: actionStagings.id,
      runId: actionStagings.runId,
      status: actionStagings.status,
      requiresApproval: actionStagings.requiresApproval,
      dispatchClaimedAt: actionStagings.dispatchClaimedAt,
      createdAt: actionStagings.createdAt,
      toolName: actionStagings.toolName,
      integration: actionStagings.integration,
      riskTier: actionStagings.riskTier,
      expiresAt: actionStagings.expiresAt,
      rowVersion: actionStagings.rowVersion,
    })
    .from(actionStagings)
    .where(owned)
    .for("update");

  return rows[0] ?? null;
}
