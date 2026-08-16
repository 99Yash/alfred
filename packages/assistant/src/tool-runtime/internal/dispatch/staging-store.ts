/**
 * The dispatch gate's persistence port (`action_stagings` + the owning run's
 * status).
 *
 * Every statement the gate needs to read or advance a staging row lives here,
 * behind this small port, so the gate itself holds no SQL. That buys two things:
 *
 *   1. The four terminal `UPDATE`s the gate used to hand-write become one
 *      `commitStaging` over the closed {@link StagingCommit} union — a fifth
 *      outcome cannot be invented at a call site, because the adapter's
 *      exhaustive `switch` stops compiling.
 *   2. The gate's ordering rules (retry suppression, cancellation, the upsert
 *      idiom, the status machine, resume re-validation, the approval floor) can
 *      be driven against an in-memory adapter, so they are testable without a
 *      live migrated Postgres. `test/dispatch/staging-store-contract.ts` is what
 *      keeps that adapter honest: both adapters run the same suite, so the fake
 *      cannot drift into a machine Postgres does not run.
 *
 * The in-memory adapter deliberately lives in `test/`, not here — a fake in
 * `src/` is a runtime someone can select in production.
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
  cancellationFenceSchema,
  effectOutcomeSchema,
  jsonValueSchema,
  runStatusSchema,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  type ActionStaging,
  type NewActionStaging,
} from "@alfred/db/schemas";
import { and, desc, eq, sql } from "drizzle-orm";

import type { PublicAppError } from "@alfred/contracts/app-errors";

/**
 * The staging columns the gate actually reads. Narrower than
 * {@link ActionStaging} on purpose: a column absent here is one the gate cannot
 * branch on, which is why the status machine stays readable.
 */
export type StagingRow = Pick<
  ActionStaging,
  | "id"
  | "runId"
  | "status"
  | "requiresApproval"
  | "toolName"
  | "riskTier"
  | "proposedInput"
  | "proposedInputHash"
  | "decidedInput"
  | "rejectReason"
  | "executeResult"
  | "executeSanitized"
  | "executeError"
  | "notifyAfterAt"
  | "notifiedAt"
  | "expiresAt"
  // #559a: the effect dimension. The gate reads these off the stored row to
  // thread the effect identity downstream and to run the ambiguity barrier.
  | "outcome"
  | "effectKey"
  | "attemptKey"
  | "requestHash"
>;

/**
 * What the gate supplies to create a staging row. Deliberately NOT the raw
 * `NewActionStaging`: `effect_key` / `attempt_key` / `outcome` are minted by the
 * store (mint-once, keep-on-replay is the conflict idiom), and `request_hash`
 * is required here because only the gate knows the target account/resource
 * binding the canonical hash must scope to.
 */
export type StagingInsertValues = Omit<NewActionStaging, "effectKey" | "attemptKey" | "outcome"> & {
  requestHash: string;
};

/** The logical effect this staging row is one attempt of (#559a). */
export function effectKeyFor(runId: string, toolCallId: string): string {
  return `eff:${runId}:${toolCallId}`;
}

/** The first (and, until the retry/reclaim slice, only) attempt of an effect. */
export function attemptKeyFor(runId: string, toolCallId: string): string {
  return `${effectKeyFor(runId, toolCallId)}:1`;
}

export type PendingApprovalPromotion = Pick<
  ActionStaging,
  "riskTier" | "proposedInput" | "proposedInputHash" | "notifyAfterAt" | "expiresAt"
>;

/**
 * The two terminal outcomes a dispatched row can reach. A closed union so the
 * "which columns does this outcome write" decision is made once, in the
 * adapter, instead of at each of the four sites that used to hand-write the
 * `UPDATE`. The `outcome` member is per-arm and mandatory: an `executed` row
 * must declare whether the effect provably happened (`succeeded`) or may have
 * happened without confirmation (`unknown` — the ambiguity-barrier case). A
 * `failed` row is either `failed` (the provider was called and the call did not
 * succeed) or `refused` (#559b) — the gate refused to call the provider at all.
 */
export type StagingCommit =
  | { status: "failed"; outcome: "failed" | "refused"; error: PublicAppError; executedAt: Date }
  | {
      status: "executed";
      outcome: "succeeded" | "unknown";
      result: JsonValue | undefined;
      sanitized: boolean;
      executedAt: Date;
    };

export interface StagingStore {
  /**
   * Most recent `rejected` row for this run + tool + input hash, or `null`.
   * Scoped to the run because ADR-0034 scopes the partial index that way.
   */
  findPriorRejection(query: {
    runId: string;
    toolName: ToolName;
    proposedInputHash: string;
  }): Promise<{ reason: string | null } | null>;

  /**
   * An unresolved `unknown` staging row for this user + canonical request hash,
   * or `null` (#559a). The gate runs this BEFORE inserting a fresh row: an
   * identical logical effect whose outcome is still `unknown` blocks a new
   * tool-call id (the model must not repeat a possibly-delivered write). The
   * `(user_id, request_hash) WHERE outcome = 'unknown'` partial unique index is
   * the DB backstop against two rows racing to `unknown`.
   */
  findUnresolvedUnknown(query: { userId: string; requestHash: string }): Promise<StagingRow | null>;

  /**
   * The owning run's status. `null` means the row is absent OR its value does
   * not parse — the gate treats both as "the run is unavailable", so the
   * distinction never escapes this module.
   */
  readRunStatus(runId: string): Promise<RunStatus | null>;

  /**
   * The run's current cancellation fence (workflows-v1 #559b). Total: an absent
   * row reads as `{ generation: 0 }` — a run that does not exist is trivially
   * not-cancelled, and production dispatch always has a real run. The dispatch
   * gate re-reads this immediately before each effect and refuses when it has
   * moved past the generation the step started under.
   */
  readCancellationFence(runId: string): Promise<CancellationFence>;

  /**
   * Idempotent on `(runId, toolCallId)`. `wasInserted` distinguishes a genuine
   * insert from a conflict; on conflict the STORED row comes back verbatim with
   * no decision/result column touched, because the resume path reads `status` /
   * `decidedInput` off it. The store mints `effectKey` / `attemptKey` /
   * `outcome` on a genuine insert; a re-dispatch of the same key keeps the
   * minted values (the conflict SET is a no-op).
   */
  upsertStaging(values: StagingInsertValues): Promise<{ row: StagingRow; wasInserted: boolean }>;

  /**
   * Monotonically raise an old pending autonomous row into the approval queue.
   * Returns null when the row is no longer pending and autonomous.
   */
  promotePendingApproval(
    stagingId: string,
    promotion: PendingApprovalPromotion,
  ): Promise<StagingRow | null>;

  /** Terminal commit onto an existing row. Bumps `row_version`. */
  commitStaging(stagingId: string, commit: StagingCommit): Promise<void>;
}

const STAGING_COLUMNS = {
  id: actionStagings.id,
  runId: actionStagings.runId,
  status: actionStagings.status,
  requiresApproval: actionStagings.requiresApproval,
  toolName: actionStagings.toolName,
  riskTier: actionStagings.riskTier,
  proposedInput: actionStagings.proposedInput,
  proposedInputHash: actionStagings.proposedInputHash,
  decidedInput: actionStagings.decidedInput,
  rejectReason: actionStagings.rejectReason,
  executeResult: actionStagings.executeResult,
  executeSanitized: actionStagings.executeSanitized,
  executeError: actionStagings.executeError,
  notifyAfterAt: actionStagings.notifyAfterAt,
  notifiedAt: actionStagings.notifiedAt,
  expiresAt: actionStagings.expiresAt,
  outcome: actionStagings.outcome,
  effectKey: actionStagings.effectKey,
  attemptKey: actionStagings.attemptKey,
  requestHash: actionStagings.requestHash,
} as const;

/**
 * `status` and `outcome` are plain `text` columns carrying a `$type`
 * assertion, so a value written by an older deploy (or by hand) reaches us
 * unvalidated. Parse them at the read — the owning boundary — rather than
 * letting the gate branch on a string TypeScript merely believes.
 */
function parseStagingRow(row: StagingRow): StagingRow {
  return {
    ...row,
    status: actionStagingStatusSchema.parse(row.status),
    outcome: effectOutcomeSchema.parse(row.outcome),
  };
}

/** The `outcome` a fresh row is born with (#559a). */
export function outcomeForInsert(values: StagingInsertValues): EffectOutcome {
  // A row that gates is in the approval queue the moment it is inserted; a row
  // the gate will dispatch immediately is `dispatching` from birth. `planned`
  // remains the DB default for writers that do not set it.
  return values.requiresApproval ? "awaiting_approval" : "dispatching";
}

/**
 * Column set for one commit arm. Exhaustive over {@link StagingCommit}: adding
 * a third outcome is a type error here, not a silently-unhandled branch.
 */
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
        // A tool legitimately returning `undefined` is stored as SQL NULL.
        // `status = 'executed'` is the discriminator for "execution happened" —
        // readers must never infer "no result yet" from a null payload.
        executeResult: commit.result === undefined ? null : commit.result,
        // Persist the sanitize verdict alongside the scrubbed result so the
        // idempotent `executed` replay re-emits the same "may be incomplete"
        // notice rather than replaying it as pristine (ADR-0070 §1.1).
        executeSanitized: commit.sanitized,
        executedAt: commit.executedAt,
      } as const;
    default: {
      const unhandled: never = commit;
      throw new Error(`[staging-store] unhandled commit outcome '${JSON.stringify(unhandled)}'`);
    }
  }
}

export const postgresStagingStore: StagingStore = {
  async findPriorRejection(query) {
    const rows = await db()
      .select({
        reason: actionStagings.rejectReason,
        decidedAt: actionStagings.decidedAt,
      })
      .from(actionStagings)
      .where(
        and(
          eq(actionStagings.runId, query.runId),
          eq(actionStagings.toolName, query.toolName),
          eq(actionStagings.proposedInputHash, query.proposedInputHash),
          eq(actionStagings.status, "rejected"),
        ),
      )
      .orderBy(desc(actionStagings.decidedAt))
      .limit(1);
    const row = rows[0];
    return row ? { reason: row.reason } : null;
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
    const parsed = runStatusSchema.safeParse(rows[0]?.status);
    return parsed.success ? parsed.data : null;
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

  async upsertStaging(values) {
    // Single upsert. On a `(run_id, tool_call_id)` conflict we do a *no-op*
    // UPDATE purely so the existing row is RETURNED — `onConflictDoNothing`
    // returns nothing on conflict, which previously forced a second SELECT-back
    // round-trip. The no-op set MUST NOT touch any decision/result column: a
    // re-dispatch of an already-staged/approved/executed call has to read the
    // stored row verbatim (the gate's resume path depends on it). `xmax = 0`
    // distinguishes a freshly-inserted row from an updated (conflict) one — the
    // standard Postgres upsert idiom — so the Replicache poke stays gated to
    // genuinely-new rows.
    const upserted = await db()
      .insert(actionStagings)
      .values({
        ...values,
        // #559a: mint-once identity. On a conflict the no-op SET below keeps
        // whatever was stored, so a re-dispatch of the same (run, tool call)
        // never rotates the effect key.
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

  async commitStaging(stagingId, commit) {
    // The single-threaded-per-run executor model (one worker holds the lease)
    // is what guarantees no other process can interleave a status flip between
    // the tool's return and this UPDATE; if that invariant ever changes, add
    // `AND status IN ('pending', 'approved')` here.
    await db()
      .update(actionStagings)
      .set({
        ...commitColumns(commit),
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(eq(actionStagings.id, stagingId));
  },
};

let activeStagingStore: StagingStore = postgresStagingStore;

/** The store the dispatch gate reads and writes through. */
export function stagingStore(): StagingStore {
  return activeStagingStore;
}

/**
 * Swap the store for a test, returning a restore closure. Mirrors
 * `_setDispatchTraceSinksForTests` — the module-binding injection precedent in
 * this feature — so no production caller of `dispatchToolCall` has to learn a
 * persistence port to serve a test.
 */
export function _setStagingStoreForTests(store: StagingStore): () => void {
  const previous = activeStagingStore;
  activeStagingStore = store;
  return () => {
    activeStagingStore = previous;
  };
}
