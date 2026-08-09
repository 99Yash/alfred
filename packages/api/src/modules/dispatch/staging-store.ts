/**
 * The dispatch gate's persistence port (`action_stagings` + the owning run's
 * status).
 *
 * Every statement the gate needs to read or advance a staging row lives here,
 * behind four methods, so the gate itself holds no SQL. That buys two things:
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

import type { RunStatus, ToolName } from "@alfred/contracts";
import { actionStagingStatusSchema, runStatusSchema } from "@alfred/contracts";
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
  | "proposedInput"
  | "decidedInput"
  | "rejectReason"
  | "executeResult"
  | "executeSanitized"
  | "executeError"
  | "notifyAfterAt"
  | "notifiedAt"
  | "expiresAt"
>;

/**
 * The two terminal outcomes a dispatched row can reach. A closed union so the
 * "which columns does this outcome write" decision is made once, in the
 * adapter, instead of at each of the four sites that used to hand-write the
 * `UPDATE`.
 */
export type StagingCommit =
  | { status: "failed"; error: PublicAppError; executedAt: Date }
  | { status: "executed"; result: unknown; sanitized: boolean; executedAt: Date };

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
   * The owning run's status. `null` means the row is absent OR its value does
   * not parse — the gate treats both as "the run is unavailable", so the
   * distinction never escapes this module.
   */
  readRunStatus(runId: string): Promise<RunStatus | null>;

  /**
   * Idempotent on `(runId, toolCallId)`. `wasInserted` distinguishes a genuine
   * insert from a conflict; on conflict the STORED row comes back verbatim with
   * no decision/result column touched, because the resume path reads `status` /
   * `decidedInput` off it.
   */
  upsertStaging(values: NewActionStaging): Promise<{ row: StagingRow; wasInserted: boolean }>;

  /** Terminal commit onto an existing row. Bumps `row_version`. */
  commitStaging(stagingId: string, commit: StagingCommit): Promise<void>;
}

const STAGING_COLUMNS = {
  id: actionStagings.id,
  runId: actionStagings.runId,
  status: actionStagings.status,
  requiresApproval: actionStagings.requiresApproval,
  toolName: actionStagings.toolName,
  proposedInput: actionStagings.proposedInput,
  decidedInput: actionStagings.decidedInput,
  rejectReason: actionStagings.rejectReason,
  executeResult: actionStagings.executeResult,
  executeSanitized: actionStagings.executeSanitized,
  executeError: actionStagings.executeError,
  notifyAfterAt: actionStagings.notifyAfterAt,
  notifiedAt: actionStagings.notifiedAt,
  expiresAt: actionStagings.expiresAt,
} as const;

/**
 * `status` is a plain `text` column carrying a `$type` assertion, so a value
 * written by an older deploy (or by hand) reaches us unvalidated. Parse it at
 * the read — the owning boundary — rather than letting the gate branch on a
 * string TypeScript merely believes.
 */
function parseStagingRow(row: StagingRow): StagingRow {
  return { ...row, status: actionStagingStatusSchema.parse(row.status) };
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
        executeError: commit.error,
        executedAt: commit.executedAt,
      } as const;
    case "executed":
      return {
        status: "executed",
        // A tool legitimately returning `undefined` is stored as SQL NULL.
        // `status = 'executed'` is the discriminator for "execution happened" —
        // readers must never infer "no result yet" from a null payload.
        executeResult: (commit.result === undefined ? null : commit.result) as object | null,
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

  async readRunStatus(runId) {
    const rows = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const parsed = runStatusSchema.safeParse(rows[0]?.status);
    return parsed.success ? parsed.data : null;
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
      .values(values)
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
