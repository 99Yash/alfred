import { db } from "@alfred/db";
import {
  activeProjectionVersions,
  projectionCursors,
  projectionRuns,
  type ActiveProjectionVersion,
  type ProjectionRun,
} from "@alfred/db/schemas";
import {
  type ObservationSource,
  type ProjectionCursorValue,
  type ProjectionRowCounts,
  type ProjectionSourceHighWatermark,
} from "@alfred/contracts";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { DbTransaction } from "@alfred/db";

export interface StartProjectionRunArgs {
  userId: string;
  projectionName: string;
  projectionVersion: number;
  sourceHighWatermark?: ProjectionSourceHighWatermark;
}

export interface StartProjectionRunResult {
  run: ProjectionRun;
  /**
   * True when the run row already existed. One attempt per version, so the caller
   * must delete the prior attempt's output rows before projecting again.
   */
  reused: boolean;
}

/**
 * Open or reuse the run for `(user, name, version)` (ADR-0067 D13). Reuses a
 * `running` or `failed` attempt; refuses a `completed` one. A new projection needs a new version.
 */
export async function startProjectionRun(
  args: StartProjectionRunArgs,
  tx?: DbTransaction,
): Promise<StartProjectionRunResult> {
  const run = async (ex: DbTransaction): Promise<StartProjectionRunResult> => {
    const [inserted] = await ex
      .insert(projectionRuns)
      .values({
        userId: args.userId,
        projectionName: args.projectionName,
        projectionVersion: args.projectionVersion,
        ...(args.sourceHighWatermark ? { sourceHighWatermark: args.sourceHighWatermark } : {}),
      })
      .onConflictDoNothing({
        target: [
          projectionRuns.userId,
          projectionRuns.projectionName,
          projectionRuns.projectionVersion,
        ],
      })
      .returning();

    if (inserted) return { run: inserted, reused: false };

    const [existing] = await ex
      .select()
      .from(projectionRuns)
      .where(
        and(
          eq(projectionRuns.userId, args.userId),
          eq(projectionRuns.projectionName, args.projectionName),
          eq(projectionRuns.projectionVersion, args.projectionVersion),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new Error(
        `[user-model.startProjectionRun] conflict but no existing run ` +
          `(${args.projectionName} v${args.projectionVersion}, user=${args.userId})`,
      );
    }

    if (existing.status === "completed") {
      throw new Error(
        `[user-model.startProjectionRun] ${args.projectionName} v${args.projectionVersion} is ` +
          `already completed — bump the version instead of re-running a completed projection ` +
          `(its checksum is what cutover trusts).`,
      );
    }

    return { run: existing, reused: true };
  };

  return tx ? run(tx) : db().transaction(run);
}

export interface CompleteProjectionRunArgs {
  runId: string;
  userId: string;
  /** Required: the DB CHECK rejects a completed run without one. */
  checksum: string;
  completedAt: Date;
  rowCounts?: ProjectionRowCounts;
  sourceHighWatermark?: ProjectionSourceHighWatermark;
}

/**
 * Mark a run `completed` (ADR-0067 D13). Only from `running` or `failed`:
 * activation already trusts a completed run's checksum and counts. The status
 * check is in the `WHERE`, so it is atomic; the follow-up read only improves the error.
 */
export async function completeProjectionRun(
  args: CompleteProjectionRunArgs,
  tx?: DbTransaction,
): Promise<ProjectionRun> {
  if (!args.checksum.trim()) {
    throw new Error(
      "[user-model.completeProjectionRun] a completed run requires a non-empty checksum " +
        "(it is what the activation cutover compares).",
    );
  }

  const ex = tx ?? db();

  const [row] = await ex
    .update(projectionRuns)
    .set({
      status: "completed",
      completedAt: args.completedAt,
      checksum: args.checksum,
      ...(args.rowCounts ? { rowCounts: args.rowCounts } : {}),
      ...(args.sourceHighWatermark ? { sourceHighWatermark: args.sourceHighWatermark } : {}),
    })
    .where(
      and(
        eq(projectionRuns.id, args.runId),
        eq(projectionRuns.userId, args.userId),
        inArray(projectionRuns.status, ["running", "failed"]),
      ),
    )
    .returning();

  if (!row) {
    const [existing] = await ex
      .select({ status: projectionRuns.status })
      .from(projectionRuns)
      .where(and(eq(projectionRuns.id, args.runId), eq(projectionRuns.userId, args.userId)))
      .limit(1);

    if (existing?.status === "completed") {
      throw new Error(
        `[user-model.completeProjectionRun] run ${args.runId} is already completed — ` +
          `completion is terminal and immutable (its checksum is what cutover trusts); ` +
          `bump the version to re-project.`,
      );
    }

    throw new Error(
      `[user-model.completeProjectionRun] no run ${args.runId} for user ${args.userId}`,
    );
  }

  return row;
}

/**
 * Mark a run `failed` (ADR-0067 D13). Never from `completed`, or the active
 * pointer could name a failed run. The `WHERE` makes the check atomic.
 */
export async function failProjectionRun(
  args: { runId: string; userId: string; completedAt?: Date },
  tx?: DbTransaction,
): Promise<ProjectionRun> {
  const ex = tx ?? db();

  const [row] = await ex
    .update(projectionRuns)
    .set({ status: "failed", ...(args.completedAt ? { completedAt: args.completedAt } : {}) })
    .where(
      and(
        eq(projectionRuns.id, args.runId),
        eq(projectionRuns.userId, args.userId),
        ne(projectionRuns.status, "completed"),
      ),
    )
    .returning();

  if (!row) {
    const [existing] = await ex
      .select({ status: projectionRuns.status })
      .from(projectionRuns)
      .where(and(eq(projectionRuns.id, args.runId), eq(projectionRuns.userId, args.userId)))
      .limit(1);

    if (existing?.status === "completed") {
      throw new Error(
        `[user-model.failProjectionRun] refusing to fail run ${args.runId}: it is already ` +
          `completed (terminal) — a completed run cannot be demoted, or the active pointer ` +
          `could name a non-completed run.`,
      );
    }

    throw new Error(`[user-model.failProjectionRun] no run ${args.runId} for user ${args.userId}`);
  }

  return row;
}

export interface WriteProjectionCursorArgs {
  userId: string;
  projectionName: string;
  projectionVersion: number;
  projectionRunId: string;
  source: ObservationSource;
  cursor: ProjectionCursorValue;
}

/**
 * Upsert the per-(run, source) replay cursor (ADR-0067 D13). Only while the run is
 * `running`: the checksum certifies the cursors. The status check shares the upsert's transaction.
 */
export async function writeProjectionCursor(
  args: WriteProjectionCursorArgs,
  tx?: DbTransaction,
): Promise<void> {
  const run = async (ex: DbTransaction): Promise<void> => {
    const [target] = await ex
      .select({ status: projectionRuns.status })
      .from(projectionRuns)
      .where(
        and(eq(projectionRuns.id, args.projectionRunId), eq(projectionRuns.userId, args.userId)),
      )
      .limit(1);

    if (!target) {
      throw new Error(
        `[user-model.writeProjectionCursor] no run ${args.projectionRunId} for user ${args.userId}`,
      );
    }

    if (target.status !== "running") {
      throw new Error(
        `[user-model.writeProjectionCursor] refusing to write a cursor to run ` +
          `${args.projectionRunId}: status is '${target.status}', not 'running' — cursors are ` +
          `part of the immutable replay record the checksum certifies.`,
      );
    }

    await ex
      .insert(projectionCursors)
      .values({
        userId: args.userId,
        projectionName: args.projectionName,
        projectionVersion: args.projectionVersion,
        projectionRunId: args.projectionRunId,
        source: args.source,
        cursor: args.cursor,
      })
      .onConflictDoUpdate({
        target: [
          projectionCursors.userId,
          projectionCursors.projectionRunId,
          projectionCursors.source,
        ],
        set: { cursor: args.cursor },
      });
  };

  return tx ? run(tx) : db().transaction(run);
}

/**
 * Point the projection at a run (ADR-0067 D13). The pointer's FK proves the run
 * exists but cannot read its status, so this checks the run is `completed` and belongs to this user.
 */
export async function activateProjectionVersion(
  args: { userId: string; projectionName: string; runId: string },
  tx?: DbTransaction,
): Promise<ActiveProjectionVersion> {
  const run = async (ex: DbTransaction): Promise<ActiveProjectionVersion> => {
    const [target] = await ex
      .select()
      .from(projectionRuns)
      .where(and(eq(projectionRuns.id, args.runId), eq(projectionRuns.userId, args.userId)))
      .limit(1);

    if (!target) {
      throw new Error(
        `[user-model.activateProjectionVersion] no run ${args.runId} for user ${args.userId}`,
      );
    }

    if (target.projectionName !== args.projectionName) {
      throw new Error(
        `[user-model.activateProjectionVersion] run ${args.runId} is projection ` +
          `'${target.projectionName}', not '${args.projectionName}'`,
      );
    }

    if (target.status !== "completed") {
      throw new Error(
        `[user-model.activateProjectionVersion] refusing to activate run ${args.runId}: ` +
          `status is '${target.status}', not 'completed' (cutover is completed-only, D13).`,
      );
    }

    const [pointer] = await ex
      .insert(activeProjectionVersions)
      .values({
        userId: args.userId,
        projectionName: args.projectionName,
        activeRunId: target.id,
        activeVersion: target.projectionVersion,
      })
      .onConflictDoUpdate({
        target: [activeProjectionVersions.userId, activeProjectionVersions.projectionName],
        set: { activeRunId: target.id, activeVersion: target.projectionVersion },
      })
      .returning();

    if (!pointer) {
      throw new Error("[user-model.activateProjectionVersion] pointer upsert returned no row");
    }

    return pointer;
  };

  return tx ? run(tx) : db().transaction(run);
}
