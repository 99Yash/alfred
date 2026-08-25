/**
 * In-memory {@link StagingStore} — the second adapter behind the dispatch gate.
 *
 * It lives in `test/` on purpose. A fake in `src/` is a runtime someone can
 * select in production; what makes this a real adapter rather than a mock is
 * `staging-store-contract.ts`, which runs the *same* suite against this and
 * against Postgres. If that suite is ever run against only one of them, this
 * file stops being evidence about anything.
 */

import {
  cancellationFenceSchema,
  toJsonValue,
  type ActionStagingStatus,
  type CancellationFence,
  type JsonValue,
  type RunStatus,
  type ToolName,
} from "@alfred/contracts";

import {
  attemptKeyFor,
  effectKeyFor,
  outcomeForInsert,
  type StagingCommit,
  type StagingInsertValues,
  type StagingRow,
  type StagingStore,
} from "../../../src/tool-runtime/internal/dispatch/staging-store";

/** Every column the fake tracks — the gate's view plus what the contract reads back. */
interface StoredRow extends StagingRow {
  userId: string;
  toolCallId: string;
  /** The #374 display projection — outside `StagingRow` because the gate never branches on it. */
  displayInput: JsonValue | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  rowVersion: number;
}

export interface MemoryStagingStore extends StagingStore {
  /** Register an owning run so `readRunStatus` can answer for it. */
  seedRun(runId: string, status: RunStatus, fence?: CancellationFence): void;
  /** Out-of-band decision write — models the approval API, not the store. */
  decide(
    stagingId: string,
    decision: {
      status: ActionStagingStatus;
      decidedInput?: unknown;
      rejectReason?: string | null;
      decidedAt?: Date;
    },
  ): void;
  /** Read a stored row back, including columns `StagingRow` does not carry. */
  readBack(stagingId: string): StoredRow | null;
  /** Every row, in insertion order. */
  rows(): readonly StoredRow[];
}

function conflictKey(runId: string, toolCallId: string): string {
  return `${runId}\x00${toolCallId}`;
}

export function memoryStagingStore(): MemoryStagingStore {
  const runs = new Map<string, RunStatus>();
  /** Per-run cancellation generation; the Postgres default (0) when unseeded. */
  const fences = new Map<string, number>();
  /** Insertion-ordered; `Map` iteration order is the fake's "most recent last". */
  const byId = new Map<string, StoredRow>();
  const byConflictKey = new Map<string, string>();
  let nextId = 0;

  function mustGet(stagingId: string): StoredRow {
    const row = byId.get(stagingId);
    if (!row) throw new Error(`[memory-staging-store] no row '${stagingId}'`);
    return row;
  }

  /** The gate's view of a stored row — a copy, so a caller cannot mutate storage. */
  function project(row: StoredRow): StagingRow {
    return {
      id: row.id,
      runId: row.runId,
      status: row.status,
      requiresApproval: row.requiresApproval,
      toolName: row.toolName,
      riskTier: row.riskTier,
      proposedInput: row.proposedInput,
      proposedInputHash: row.proposedInputHash,
      decidedInput: row.decidedInput,
      rejectReason: row.rejectReason,
      executeResult: row.executeResult,
      executeSanitized: row.executeSanitized,
      executeError: row.executeError,
      notifyAfterAt: row.notifyAfterAt,
      notifiedAt: row.notifiedAt,
      expiresAt: row.expiresAt,
      outcome: row.outcome,
      effectKey: row.effectKey,
      attemptKey: row.attemptKey,
      requestHash: row.requestHash,
    };
  }

  return {
    seedRun(runId, status, fence) {
      runs.set(runId, status);
      fences.set(runId, fence?.generation ?? 0);
    },

    decide(stagingId, decision) {
      const row = mustGet(stagingId);
      row.status = decision.status;
      if (decision.decidedInput !== undefined) {
        row.decidedInput = toJsonValue(decision.decidedInput);
      }
      if (decision.rejectReason !== undefined) row.rejectReason = decision.rejectReason;
      row.decidedAt = decision.decidedAt ?? new Date();
      row.rowVersion += 1;
    },

    readBack(stagingId) {
      const row = byId.get(stagingId);
      return row ? { ...row } : null;
    },

    rows() {
      return [...byId.values()].map((row) => ({ ...row }));
    },

    async findPriorRejection(query) {
      // Mirrors the adapter's `ORDER BY decided_at DESC LIMIT 1`. A null
      // `decided_at` sorts last, matching Postgres `DESC` (NULLS LAST is the
      // default for DESC in Postgres — nulls are treated as largest, so
      // `DESC` puts them FIRST; the gate only ever writes `decided_at` with
      // the rejection, so a rejected row without one does not occur. The
      // contract suite pins the ordering that does.)
      const candidates = [...byId.values()].filter(
        (row) =>
          row.runId === query.runId &&
          row.toolName === query.toolName &&
          row.proposedInputHash === query.proposedInputHash &&
          row.status === "rejected",
      );
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0));
      return { reason: candidates[0]!.rejectReason };
    },

    async findUnresolvedUnknown(query) {
      const row = [...byId.values()].find(
        (candidate) =>
          candidate.userId === query.userId &&
          candidate.requestHash === query.requestHash &&
          candidate.outcome === "unknown",
      );
      return row ? project(row) : null;
    },

    async readRunStatus(runId) {
      return runs.get(runId) ?? null;
    },

    async readCancellationFence(runId) {
      return cancellationFenceSchema.parse({ generation: fences.get(runId) ?? 0 });
    },

    async upsertStaging(values: StagingInsertValues) {
      const key = conflictKey(values.runId, values.toolCallId);
      const existingId = byConflictKey.get(key);
      if (existingId !== undefined) {
        // The no-op conflict SET: nothing is written, the stored row is
        // returned verbatim — the minted effect identity and outcome survive a
        // re-dispatch, exactly as Postgres keeps them.
        return { row: project(mustGet(existingId)), wasInserted: false };
      }
      nextId += 1;
      const id = values.id ?? `as_mem_${nextId}`;
      const row: StoredRow = {
        id,
        userId: values.userId,
        runId: values.runId,
        toolCallId: values.toolCallId,
        riskTier: values.riskTier,
        status: values.status ?? "pending",
        requiresApproval: values.requiresApproval,
        toolName: values.toolName as ToolName,
        proposedInput: values.proposedInput,
        displayInput: values.displayInput ?? null,
        proposedInputHash: values.proposedInputHash,
        decidedInput: values.decidedInput ?? null,
        rejectReason: values.rejectReason ?? null,
        decidedAt: values.decidedAt ?? null,
        executeResult: values.executeResult ?? null,
        executeSanitized: values.executeSanitized ?? false,
        executeError: values.executeError ?? null,
        executedAt: values.executedAt ?? null,
        notifyAfterAt: values.notifyAfterAt ?? null,
        notifiedAt: values.notifiedAt ?? null,
        expiresAt: values.expiresAt ?? null,
        outcome: outcomeForInsert(values),
        effectKey: effectKeyFor(values.runId, values.toolCallId),
        attemptKey: attemptKeyFor(values.runId, values.toolCallId),
        requestHash: values.requestHash,
        rowVersion: values.rowVersion ?? 1,
      };
      byId.set(id, row);
      byConflictKey.set(key, id);
      return { row: project(row), wasInserted: true };
    },

    async promotePendingApproval(stagingId, promotion) {
      const row = mustGet(stagingId);
      if (row.status !== "pending" || row.requiresApproval) return null;
      row.riskTier = promotion.riskTier;
      row.proposedInput = promotion.proposedInput;
      row.displayInput = promotion.displayInput;
      row.proposedInputHash = promotion.proposedInputHash;
      row.requiresApproval = true;
      row.outcome = "awaiting_approval";
      row.notifyAfterAt = promotion.notifyAfterAt;
      row.expiresAt = promotion.expiresAt;
      row.rowVersion += 1;
      return project(row);
    },

    async commitStaging(stagingId: string, commit: StagingCommit) {
      const row = mustGet(stagingId);
      switch (commit.status) {
        case "failed":
          row.status = "failed";
          row.outcome = commit.outcome;
          row.executeError = commit.error;
          row.executedAt = commit.executedAt;
          break;
        case "executed":
          row.status = "executed";
          row.outcome = commit.outcome;
          row.executeResult = commit.result === undefined ? null : commit.result;
          row.executeSanitized = commit.sanitized;
          row.executedAt = commit.executedAt;
          break;
        default: {
          const unhandled: never = commit;
          throw new Error(
            `[memory-staging-store] unhandled commit outcome '${JSON.stringify(unhandled)}'`,
          );
        }
      }
      row.rowVersion += 1;
    },
  };
}
