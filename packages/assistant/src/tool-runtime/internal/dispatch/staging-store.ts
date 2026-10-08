/**
 * The dispatch gate's only SQL: `action_stagings` and the owning run's status.
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
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { PublicAppError } from "@alfred/contracts/app-errors";

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
  | "proposedInputHash"
  | "decidedInput"
  | "rejectReason"
  | "executeResult"
  | "executeSanitized"
  | "executeError"
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
 * The terminal outcomes. `unknown`: the effect may have happened without
 * confirmation. `refused`: the gate never called the provider.
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
  /** Most recent row in `statuses` for this run, tool, and input hash. */
  findPriorRejection(query: {
    runId: string;
    toolName: ToolName;
    proposedInputHash: string;
    statuses: readonly PriorRejectionStatus[];
  }): Promise<{ reason: string | null; status: ActionStaging["status"] } | null>;

  /**
   * An unresolved `unknown` row for this user and request hash. It blocks a
   * repeat of a write that may have been delivered. A unique index backs it.
   */
  findUnresolvedUnknown(query: { userId: string; requestHash: string }): Promise<StagingRow | null>;

  /** `null` when the run is absent or its status does not parse. */
  readRunStatus(runId: string): Promise<RunStatus | null>;

  /** An absent run reads as `{ generation: 0 }`. */
  readCancellationFence(runId: string): Promise<CancellationFence>;

  /** Idempotent on `(runId, toolCallId)`. On conflict, returns the stored row unchanged. */
  upsertStaging(values: StagingInsertValues): Promise<{ row: StagingRow; wasInserted: boolean }>;

  /** Move a pending autonomous row into the approval queue, or return null. */
  promotePendingApproval(
    stagingId: string,
    promotion: PendingApprovalPromotion,
  ): Promise<StagingRow | null>;

  /**
   * Commit from the observed state, or fill the result when the MCP broker
   * already wrote the same outcome. False for any other outcome.
   */
  commitStaging(
    stagingId: string,
    expected: Pick<StagingRow, "status" | "outcome">,
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
        status: actionStagings.status,
        decidedAt: actionStagings.decidedAt,
      })
      .from(actionStagings)
      .where(
        and(
          eq(actionStagings.runId, query.runId),
          eq(actionStagings.toolName, query.toolName),
          eq(actionStagings.proposedInputHash, query.proposedInputHash),
          inArray(actionStagings.status, query.statuses),
        ),
      )
      .orderBy(desc(actionStagings.decidedAt))
      .limit(1);

    const row = rows[0];

    return row ? { reason: row.reason, status: row.status } : null;
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
