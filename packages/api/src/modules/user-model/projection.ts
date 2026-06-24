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
import { type DbExecutor } from "./executor";

export interface StartProjectionRunArgs {
  userId: string;
  projectionName: string;
  projectionVersion: number;
  sourceHighWatermark?: ProjectionSourceHighWatermark;
}

export interface StartProjectionRunResult {
  run: ProjectionRun;
  /**
   * True when a run row already existed for `(user, name, version)` and was
   * returned as-is. A projection version is SINGLE-ATTEMPT (`projection_runs` is
   * unique on `(user, name, version)`), so a re-run reuses the row; the caller
   * must clear the prior attempt's output rows (`DELETE … WHERE projection_run_id
   * = run.id`) before re-projecting into it.
   */
  reused: boolean;
}

/**
 * Open (or reuse) the `running` projection run for `(user, name, version)`
 * (ADR-0067 D13). Reuses an existing `running`/`failed` attempt at the same
 * version (single-attempt key); refuses to reopen a `completed` one — a
 * completed version is immutable, so a new projection means a new VERSION, not a
 * silent re-run that would diverge from the checksum cutover already trusts.
 */
export async function startProjectionRun(
  args: StartProjectionRunArgs,
  tx?: DbExecutor,
): Promise<StartProjectionRunResult> {
  const run = async (ex: DbExecutor): Promise<StartProjectionRunResult> => {
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
  /** Determinism checksum over time-invariant components — REQUIRED (the DB CHECK on completed runs). */
  checksum: string;
  completedAt: Date;
  rowCounts?: ProjectionRowCounts;
  sourceHighWatermark?: ProjectionSourceHighWatermark;
}

/**
 * Mark a run `completed` (ADR-0067 D13). A completed run MUST carry a non-empty
 * `checksum` and a `completedAt` (the `projection_runs_completed_*` CHECKs +
 * `projection_runs_completed_at_consistency` enforce it at the DB; this surfaces
 * a clear error before the round-trip). Only completed runs are eligible for
 * activation.
 *
 * Completion is a GUARDED one-way transition: it fires only from `running` /
 * `failed` (a retried `failed` attempt reuses the same run row — see
 * `startProjectionRun`). `completed` is TERMINAL — re-completing would overwrite
 * the `checksum` / `completedAt` / `rowCounts` / `sourceHighWatermark` that the
 * activation cutover already trusts, so a second call is rejected rather than
 * silently mutating an immutable run record. The status predicate lives in the
 * `WHERE` so the guard is atomic (a concurrent completer can't slip past a
 * read-then-write gap); the follow-up read only sharpens the error message.
 */
export async function completeProjectionRun(
  args: CompleteProjectionRunArgs,
  tx?: DbExecutor,
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
 * Mark a run `failed` (ADR-0067 D13). `completedAt` is optional — `failed` may
 * record when the run gave up, and the consistency CHECK leaves it free.
 *
 * `completed` is TERMINAL: a run that already cut over (or is eligible to) must
 * never be demoted to `failed` after the fact, or the active pointer could name
 * a non-completed run and the cutover invariant would be violated post hoc. The
 * `status <> 'completed'` predicate in the `WHERE` makes the rejection atomic;
 * the follow-up read only sharpens the error.
 */
export async function failProjectionRun(
  args: { runId: string; userId: string; completedAt?: Date },
  tx?: DbExecutor,
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
 * Upsert the per-(run, source) replay cursor that proves no observation is
 * double-counted (ADR-0067 D13). Keyed on `(user, run, source)`; the composite
 * FK binds the cursor's name+version to the run's.
 *
 * Cursors are part of the replay proof the run's checksum certifies, so they
 * share the run's immutability: a cursor may only be written while the run is
 * `running`. Writing one after the run is `completed` / `failed` would mutate
 * the audit trail of an already-sealed (or abandoned) run. The status is read
 * and asserted inside the same transaction as the upsert so the check can't race
 * a concurrent completion.
 */
export async function writeProjectionCursor(
  args: WriteProjectionCursorArgs,
  tx?: DbExecutor,
): Promise<void> {
  const run = async (ex: DbExecutor): Promise<void> => {
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
 * Flip the active projection pointer to a run — the cutover (ADR-0067 D13).
 *
 * THE completed-only ACTIVATION GUARD that the schema explicitly defers to P1
 * (`active_projection_versions` comment: "the completed-only guard stays in the
 * activation helper — a FK can't assert the target row's status"). Activating a
 * still-`running`/`failed` run would point every consumer's active view at a
 * half-built or abandoned projection. So this reads the run, asserts it belongs
 * to this user+projection AND is `completed`, then upserts the `(user, name)`
 * pointer to it (and its version). The 4-column run FK on the pointer
 * independently guarantees the named run/version exists; this adds the status
 * check the FK structurally cannot.
 */
export async function activateProjectionVersion(
  args: { userId: string; projectionName: string; runId: string },
  tx?: DbExecutor,
): Promise<ActiveProjectionVersion> {
  const run = async (ex: DbExecutor): Promise<ActiveProjectionVersion> => {
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
