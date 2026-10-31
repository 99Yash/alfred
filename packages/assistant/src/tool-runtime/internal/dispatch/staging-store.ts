/**
 * The dispatch gate's only SQL: `action_stagings`, the owning run's status, and the chat
 * thread's full-autonomy flag.
 * `test/tool-runtime/dispatch/staging-store-contract.ts` runs the same suite on
 * this and the in-memory test adapter.
 *
 * Second owner: `tool-runtime/mcp` (`broker.ts`, `invocations.ts`, `recovery.ts`)
 * writes staging rows together with its invocation rows, outside this port.
 */

import type {
  CancellationFence,
  EffectOutcome,
  JsonValue,
  RunStatus,
  ToolName,
} from "@alfred/contracts";
import {
  actionStagingStatusSchema,
  assertNever,
  cancellationFenceSchema,
  effectOutcomeSchema,
  jsonValueSchema,
  toJsonValue,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  chatThreads,
  type ActionStaging,
  type NewActionStaging,
} from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { PublicAppError } from "@alfred/contracts/app-errors";
import { dispatchLease, type DispatchStepLease } from "@alfred/assistant/tool-runtime";

import type { ToolEffects } from "../registry";

/** The columns the gate reads. A column absent here is one it cannot branch on. */
export type StagingRow = Pick<
  ActionStaging,
  | "id"
  | "runId"
  | "status"
  | "requiresApproval"
  | "toolName"
  | "riskTier"
  | "proposedInput"
  | "displayInput"
  | "proposedInputHash"
  | "decidedInput"
  | "rejectReason"
  | "executeResult"
  | "executeSanitized"
  | "executeEffects"
  | "executeError"
  | "dispatchClaimedAt"
  | "notifyAfterAt"
  | "notifiedAt"
  | "expiresAt"
  | "outcome"
  | "effectKey"
  | "attemptKey"
  | "requestHash"
>;

/**
 * The store mints the effect keys and `outcome`. `displayInput` is required so
 * redacted input always travels with the raw `proposedInput`.
 */
export type StagingInsertValues = Omit<
  NewActionStaging,
  "effectKey" | "attemptKey" | "outcome" | "displayInput"
> & {
  requestHash: string;
  displayInput: JsonValue;
};

/** The logical effect this staging row is one attempt of (#559a). */
export function effectKeyFor(runId: string, toolCallId: string): string {
  return `eff:${runId}:${toolCallId}`;
}

/** The first attempt of an effect. */
export function attemptKeyFor(runId: string, toolCallId: string): string {
  return `${effectKeyFor(runId, toolCallId)}:1`;
}

/** `STAGING_ARM` picks the list per arm. The question arm adds `expired` (ADR-0099). */
export type PriorRejectionStatus = Extract<ActionStaging["status"], "rejected" | "expired">;

export type PendingApprovalPromotion = Pick<
  ActionStaging,
  | "riskTier"
  | "proposedInput"
  | "displayInput"
  | "proposedInputHash"
  | "notifyAfterAt"
  | "expiresAt"
>;

/**
 * The input a claimed and unfinished call goes back to the user with. The raw input to run, not a
 * redacted copy: approve runs `proposedInput`.
 */
export type InterruptedRestage = Omit<PendingApprovalPromotion, "proposedInputHash">;

/** An earlier attempt claimed the call, so its effect may already exist. */
export function stagingMayHaveRun(row: Pick<StagingRow, "dispatchClaimedAt">): boolean {
  return row.dispatchClaimedAt !== null;
}

/**
 * A row that dispatch may execute now: approved by the user, or an autonomous `pending` row. A
 * gated `pending` row is a card, so it is not runnable. `runnableStagingSql` is the same predicate
 * for a `WHERE`; keep the two together.
 */
export function isRunnableStaging(row: Pick<StagingRow, "status" | "requiresApproval">): boolean {
  return row.status === "approved" || (row.status === "pending" && !row.requiresApproval);
}

function runnableStagingSql() {
  return or(
    eq(actionStagings.status, "approved"),
    and(eq(actionStagings.status, "pending"), eq(actionStagings.requiresApproval, false)),
  );
}

/** A runnable row that an attempt claimed and did not finish. It goes back to the user. */
export function isInterruptedClaim(
  row: Pick<StagingRow, "status" | "requiresApproval" | "dispatchClaimedAt">,
): boolean {
  return stagingMayHaveRun(row) && isRunnableStaging(row);
}

/**
 * How a lease check under the run lock ends.
 * - `lease_lost`: another attempt owns the run. Do not write the row: it may belong to the winner.
 * - `fenced`: this attempt still owns the run, but a cancel moved the fence or cancelled the run.
 * - `run_ended`: the run ended in another terminal status (for example `failed`). It was not
 *   cancelled, so do not close the row as a cancelled call.
 */
type LeaseLoss = "lease_lost" | "fenced" | "run_ended";

/**
 * - `claimed`: this attempt owns the call and may run it.
 * - `not_claimable`: the row is no longer an unclaimed runnable row of this run.
 */
export type DispatchClaim = "claimed" | LeaseLoss | "not_claimable";

/**
 * - `restaged`: the row is a new approval card.
 * - `moved`: the row left the claimed state first (for example, a lost attempt committed its
 *   result). `row` is the current row, so the caller settles from it.
 */
export type InterruptedRestageResult =
  | { kind: "restaged"; row: StagingRow }
  | { kind: "moved"; row: StagingRow }
  | { kind: LeaseLoss };

/**
 * The terminal outcomes. `unknown`: the effect may have happened without
 * confirmation. `refused`: the gate did not call the provider for this decision. A row with
 * `dispatch_claimed_at` set may still have reached it in an earlier, interrupted attempt.
 */
export type StagingCommit =
  | { status: "failed"; outcome: "failed" | "refused"; error: PublicAppError; executedAt: Date }
  | {
      status: "executed";
      outcome: "succeeded" | "unknown";
      result: JsonValue | undefined;
      sanitized: boolean;
      /** Written with `result`, so a replay returns the effects of the live call. */
      effects: ToolEffects;
      executedAt: Date;
    };

export interface StagingStore {
  /** Match the first proposal or its edit. A claimed expiry also suppresses an identical retry. */
  findPriorRejection(query: {
    runId: string;
    toolName: ToolName;
    proposedInputHash: string;
    input?: JsonValue;
    statuses: readonly PriorRejectionStatus[];
  }): Promise<{
    reason: string | null;
    status: ActionStaging["status"];
    mayHaveRun?: true;
  } | null>;

  /** Read a saved call before binding against a possibly changed tool schema. */
  readStaging(query: { runId: string; toolCallId: string }): Promise<StagingRow | null>;

  /**
   * An unresolved `unknown` row for this user and request hash. It blocks a
   * repeat of a write that may have been delivered. A unique index backs it.
   */
  findUnresolvedUnknown(query: { userId: string; requestHash: string }): Promise<StagingRow | null>;

  /** `null` when the run is absent or its status does not parse. */
  readRunStatus(runId: string): Promise<RunStatus | null>;

  /** An absent run reads as `{ generation: 0 }`. */
  readCancellationFence(runId: string): Promise<CancellationFence>;

  /**
   * The thread's full-autonomy flag, read live (ADR-0069 amendment). A thread that is absent or
   * owned by another user reads as `false`, so a doubt keeps the card.
   */
  readThreadFullAutonomy(query: { userId: string; threadId: string }): Promise<boolean>;

  /** Idempotent on `(runId, toolCallId)`. On conflict, returns the stored row unchanged. */
  upsertStaging(values: StagingInsertValues): Promise<{ row: StagingRow; wasInserted: boolean }>;

  /** Move a pending autonomous row into the approval queue, or return null. */
  promotePendingApproval(
    stagingId: string,
    promotion: PendingApprovalPromotion,
  ): Promise<StagingRow | null>;

  /**
   * Mark the call as started, just before an `unsafe` tool's `execute`. One transaction runs the
   * step commit's lease check (`withStepLease`, through the `dispatchLease` seam), and then sets
   * `dispatch_claimed_at` to `claimedAt` on an unclaimed runnable row (`isRunnableStaging`). The
   * caller keeps `claimedAt` as the token that its commit fences on.
   */
  claimDispatch(
    stagingId: string,
    lease: DispatchStepLease,
    claimedAt: Date,
  ): Promise<DispatchClaim>;

  /**
   * Send a claimed and unfinished call back to the user (replay safety), under the same lease
   * check as `claimDispatch`. The row becomes a `pending` approval again, and
   * `dispatch_claimed_at` stays set, so the card says it may have run. A user edit stays in
   * `decided_input`, so "Run again" still reports the edit to the model. The original proposal
   * hash stays fixed, so rejection suppresses both the original call and its edited input.
   */
  restageInterrupted(
    stagingId: string,
    lease: DispatchStepLease,
    restage: InterruptedRestage,
  ): Promise<InterruptedRestageResult>;

  /** The provider handle that a tool kept for this call (`provider_ref`), or null. */
  readProviderRef(stagingId: string): Promise<string | null>;

  /**
   * Keep `ref` as the call's provider handle when no attempt kept one first. Returns the kept
   * handle: `ref`, or the handle of the attempt that wrote first.
   */
  recordProviderRef(stagingId: string, ref: string): Promise<string>;

  /**
   * Commit from the observed state, or fill the result when the MCP broker
   * already wrote the same outcome. False for any other outcome.
   * `dispatchClaimedAt` must also match. A zombie attempt that claimed at t1 then cannot commit
   * after a restage and "Run again" set the row back to `approved` (claim cleared or re-claimed).
   */
  commitStaging(
    stagingId: string,
    expected: Pick<StagingRow, "status" | "outcome" | "dispatchClaimedAt">,
    commit: StagingCommit,
  ): Promise<boolean>;
}

const STAGING_COLUMNS = {
  id: actionStagings.id,
  runId: actionStagings.runId,
  status: actionStagings.status,
  requiresApproval: actionStagings.requiresApproval,
  toolName: actionStagings.toolName,
  riskTier: actionStagings.riskTier,
  proposedInput: actionStagings.proposedInput,
  displayInput: actionStagings.displayInput,
  proposedInputHash: actionStagings.proposedInputHash,
  decidedInput: actionStagings.decidedInput,
  rejectReason: actionStagings.rejectReason,
  executeResult: actionStagings.executeResult,
  executeSanitized: actionStagings.executeSanitized,
  executeEffects: actionStagings.executeEffects,
  executeError: actionStagings.executeError,
  dispatchClaimedAt: actionStagings.dispatchClaimedAt,
  notifyAfterAt: actionStagings.notifyAfterAt,
  notifiedAt: actionStagings.notifiedAt,
  expiresAt: actionStagings.expiresAt,
  outcome: actionStagings.outcome,
  effectKey: actionStagings.effectKey,
  attemptKey: actionStagings.attemptKey,
  requestHash: actionStagings.requestHash,
} as const;

/** `status` and `outcome` are `text` columns with only a `$type` assertion, so parse them. */
function parseStagingRow(row: StagingRow): StagingRow {
  return {
    ...row,
    status: actionStagingStatusSchema.parse(row.status),
    outcome: effectOutcomeSchema.parse(row.outcome),
  };
}

export function outcomeForInsert(values: StagingInsertValues): EffectOutcome {
  return values.requiresApproval ? "awaiting_approval" : "dispatching";
}

/** No effects store as NULL, the same as a row from before the column. */
export function effectsColumn(effects: ToolEffects): JsonValue | null {
  return Object.values(effects).every((value) => value === undefined) ? null : toJsonValue(effects);
}

function commitColumns(commit: StagingCommit) {
  switch (commit.status) {
    case "failed":
      return {
        status: "failed",
        outcome: commit.outcome,
        executeError: jsonValueSchema.parse(commit.error),
        executedAt: commit.executedAt,
      } as const;
    case "executed":
      return {
        status: "executed",
        outcome: commit.outcome,
        // `undefined` is stored as NULL. `status` alone says the tool ran.
        executeResult: commit.result === undefined ? null : commit.result,
        // A replay must repeat the "may be incomplete" notice (ADR-0070 §1.1).
        executeSanitized: commit.sanitized,
        executeEffects: effectsColumn(commit.effects),
        executedAt: commit.executedAt,
      } as const;
    default:
      return assertNever(commit, "staging commit status");
  }
}

/**
 * Run `write` under the step commit's own lease check (the `dispatchLease` seam): one transaction
 * that locks the `agent_runs` row first. The seam reports a cancel and any other run end as one
 * `terminal` cause, so a read after it splits them. A moved fence and a terminal status do not
 * change back, so this read agrees with the locked check.
 */
async function withDispatchLease<T>(
  lease: DispatchStepLease,
  write: (tx: DbTransaction) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; loss: LeaseLoss }> {
  const leased = await dispatchLease().withStepLease(lease, write);

  if (leased.ok) return leased;

  if (leased.cause === "reclaim") return { ok: false, loss: "lease_lost" };

  const [run] = await db()
    .select({ cancellationGeneration: agentRuns.cancellationGeneration, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, lease.runId));

  if (!run) return { ok: false, loss: "lease_lost" };

  const cancelled =
    run.cancellationGeneration !== lease.fence.generation || run.status === "cancelled";

  return { ok: false, loss: cancelled ? "fenced" : "run_ended" };
}

export const postgresStagingStore: StagingStore = {
  async findPriorRejection(query) {
    const rows = await db()
      .select({
        reason: actionStagings.rejectReason,
        status: actionStagings.status,
        decidedAt: actionStagings.decidedAt,
        dispatchClaimedAt: actionStagings.dispatchClaimedAt,
      })
      .from(actionStagings)
      .where(
        and(
          eq(actionStagings.runId, query.runId),
          eq(actionStagings.toolName, query.toolName),
          or(
            eq(actionStagings.proposedInputHash, query.proposedInputHash),
            query.input === undefined ? undefined : eq(actionStagings.proposedInput, query.input),
            query.input === undefined ? undefined : eq(actionStagings.decidedInput, query.input),
          ),
          or(
            inArray(actionStagings.status, query.statuses),
            and(eq(actionStagings.status, "expired"), isNotNull(actionStagings.dispatchClaimedAt)),
          ),
        ),
      )
      .orderBy(desc(actionStagings.decidedAt))
      .limit(1);

    const row = rows[0];

    return row
      ? {
          reason: row.reason,
          status: row.status,
          ...(stagingMayHaveRun(row) ? { mayHaveRun: true as const } : {}),
        }
      : null;
  },

  async readStaging(query) {
    const [row] = await db()
      .select(STAGING_COLUMNS)
      .from(actionStagings)
      .where(
        and(eq(actionStagings.runId, query.runId), eq(actionStagings.toolCallId, query.toolCallId)),
      );

    return row ? parseStagingRow(row) : null;
  },

  async findUnresolvedUnknown(query) {
    const rows = await db()
      .select(STAGING_COLUMNS)
      .from(actionStagings)
      .where(
        and(
          eq(actionStagings.userId, query.userId),
          eq(actionStagings.requestHash, query.requestHash),
          eq(actionStagings.outcome, "unknown"),
        ),
      )
      .limit(1);

    const row = rows[0];

    return row ? parseStagingRow(row) : null;
  },

  async readRunStatus(runId) {
    const rows = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    return rows[0]?.status ?? null;
  },

  async readCancellationFence(runId) {
    const rows = await db()
      .select({ generation: agentRuns.cancellationGeneration })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    return cancellationFenceSchema.parse({
      generation: rows[0]?.generation ?? 0,
    });
  },

  async readThreadFullAutonomy(query) {
    const rows = await db()
      .select({ fullAutonomy: chatThreads.fullAutonomy })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, query.threadId), eq(chatThreads.userId, query.userId)))
      .limit(1);

    return rows[0]?.fullAutonomy === true;
  },

  async upsertStaging(values) {
    // The no-op conflict UPDATE exists only to RETURN the stored row, and must not
    // touch decision or result columns. `xmax = 0` is true only for a fresh insert.
    const upserted = await db()
      .insert(actionStagings)
      .values({
        ...values,
        effectKey: effectKeyFor(values.runId, values.toolCallId),
        attemptKey: attemptKeyFor(values.runId, values.toolCallId),
        outcome: outcomeForInsert(values),
      })
      .onConflictDoUpdate({
        target: [actionStagings.runId, actionStagings.toolCallId],
        set: { rowVersion: sql`${actionStagings.rowVersion}` },
      })
      .returning({ ...STAGING_COLUMNS, wasInserted: sql<boolean>`xmax = 0` });

    const upsertedRow = upserted[0];

    if (!upsertedRow) {
      throw new Error(
        `[dispatch] action_stagings upsert returned no row (run=${values.runId}, toolCallId=${values.toolCallId})`,
      );
    }

    const { wasInserted, ...rowColumns } = upsertedRow;

    return { row: parseStagingRow(rowColumns), wasInserted };
  },

  async promotePendingApproval(stagingId, promotion) {
    const promoted = await db()
      .update(actionStagings)
      .set({
        riskTier: promotion.riskTier,
        proposedInput: promotion.proposedInput,
        displayInput: promotion.displayInput,
        proposedInputHash: promotion.proposedInputHash,
        requiresApproval: true,
        outcome: "awaiting_approval",
        notifyAfterAt: promotion.notifyAfterAt,
        expiresAt: promotion.expiresAt,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(
        and(
          eq(actionStagings.id, stagingId),
          eq(actionStagings.status, "pending"),
          eq(actionStagings.requiresApproval, false),
        ),
      )
      .returning(STAGING_COLUMNS);

    const row = promoted[0];

    return row ? parseStagingRow(row) : null;
  },

  async claimDispatch(stagingId, lease, claimedAt) {
    const leased = await withDispatchLease(lease, async (tx): Promise<DispatchClaim> => {
      const claimed = await tx
        .update(actionStagings)
        .set({
          // A JS time, not `now()`: millisecond precision reads back equal, so the commit can match it.
          dispatchClaimedAt: claimedAt,
          rowVersion: sql`${actionStagings.rowVersion} + 1`,
        })
        .where(
          and(
            eq(actionStagings.id, stagingId),
            eq(actionStagings.runId, lease.runId),
            runnableStagingSql(),
            isNull(actionStagings.dispatchClaimedAt),
          ),
        )
        .returning({ id: actionStagings.id });

      return claimed.length > 0 ? "claimed" : "not_claimable";
    });

    return leased.ok ? leased.value : leased.loss;
  },

  async restageInterrupted(stagingId, lease, restage) {
    const leased = await withDispatchLease(lease, async (tx): Promise<InterruptedRestageResult> => {
      const [restaged] = await tx
        .update(actionStagings)
        .set({
          status: "pending",
          requiresApproval: true,
          outcome: "awaiting_approval",
          riskTier: restage.riskTier,
          // The card shows `proposedInput`, so an earlier edit moves there and approve runs it.
          proposedInput: restage.proposedInput,
          displayInput: restage.displayInput,
          // Keep the first proposal hash: rejection must also suppress the model's original call.
          // `decided_input` stays: an approve with no new edit leaves it, so the result still
          // reports the user's earlier edit to the model.
          decidedAt: null,
          notifyAfterAt: restage.notifyAfterAt,
          // A new card gets a new notice.
          notifiedAt: null,
          expiresAt: restage.expiresAt,
          rowVersion: sql`${actionStagings.rowVersion} + 1`,
        })
        .where(
          and(
            eq(actionStagings.id, stagingId),
            eq(actionStagings.runId, lease.runId),
            // `isInterruptedClaim`: a gated `pending` row is already a card.
            runnableStagingSql(),
            isNotNull(actionStagings.dispatchClaimedAt),
          ),
        )
        .returning(STAGING_COLUMNS);

      if (restaged) return { kind: "restaged", row: parseStagingRow(restaged) };

      const [current] = await tx
        .select(STAGING_COLUMNS)
        .from(actionStagings)
        .where(eq(actionStagings.id, stagingId));

      if (!current) {
        throw new Error(`[dispatch] interrupted staging row is gone (staging=${stagingId})`);
      }

      return { kind: "moved", row: parseStagingRow(current) };
    });

    return leased.ok ? leased.value : { kind: leased.loss };
  },

  async readProviderRef(stagingId) {
    const [row] = await db()
      .select({ providerRef: actionStagings.providerRef })
      .from(actionStagings)
      .where(eq(actionStagings.id, stagingId));

    return row?.providerRef ?? null;
  },

  async recordProviderRef(stagingId, ref) {
    // No `row_version` bump: the synced row does not carry `provider_ref`.
    const [recorded] = await db()
      .update(actionStagings)
      .set({ providerRef: ref })
      .where(and(eq(actionStagings.id, stagingId), isNull(actionStagings.providerRef)))
      .returning({ id: actionStagings.id });

    if (recorded) return ref;

    const kept = await postgresStagingStore.readProviderRef(stagingId);

    if (kept === null) throw new Error(`[dispatch] staging ${stagingId} not found`);

    return kept;
  },

  async commitStaging(stagingId, expected, commit) {
    const [updated] = await db()
      .update(actionStagings)
      .set({
        ...commitColumns(commit),
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(
        and(
          eq(actionStagings.id, stagingId),
          expected.dispatchClaimedAt === null
            ? isNull(actionStagings.dispatchClaimedAt)
            : eq(actionStagings.dispatchClaimedAt, expected.dispatchClaimedAt),
          or(
            and(
              eq(actionStagings.status, expected.status),
              eq(actionStagings.outcome, expected.outcome),
            ),
            and(
              eq(actionStagings.status, commit.status),
              eq(actionStagings.outcome, commit.outcome),
              commit.status === "executed"
                ? isNull(actionStagings.executeResult)
                : isNull(actionStagings.executeError),
            ),
          ),
        ),
      )
      .returning({ id: actionStagings.id });

    return Boolean(updated);
  },
};

let activeStagingStore: StagingStore = postgresStagingStore;

/** The store the dispatch gate reads and writes through. */
export function stagingStore(): StagingStore {
  return activeStagingStore;
}

/** Swap the store for a test. Returns a restore closure. */
export function _setStagingStoreForTests(store: StagingStore): () => void {
  const previous = activeStagingStore;
  activeStagingStore = store;

  return () => {
    activeStagingStore = previous;
  };
}
