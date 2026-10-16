/**
 * The one writer of a completed Gmail user-model projection run (ADR-0067).
 *
 * The manual backfill and the scheduled refold both call this, so a run always
 * holds the same tables: `entity_profiles.kind` and grounded `works_at` edges.
 * Gating stays with the caller: the backfill compares dry runs, the refold checks
 * logic drift. Activation also stays with the caller.
 */
import { USER_MODEL_PROJECTION_NAME, type ProjectionSourceHighWatermark } from "@alfred/contracts";
import { type DbTransaction } from "@alfred/db";
import { entityEdges, entityProfiles } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { projectGmailWorksAtEdges } from "./gmail-edge-fold";
import { projectGmailKindProfiles } from "./gmail-kind-fold";
import { completeProjectionRun, startProjectionRun, writeProjectionCursor } from "./projection";

export interface FoldGmailProjectionRunArgs {
  readonly userId: string;
  readonly projectionVersion: number;
  /** The run's replay bound. Its `gmail` cursor bounds both folds and becomes the run cursor. */
  readonly sourceHighWatermark: ProjectionSourceHighWatermark;
  /** The user's own addresses, canonical and sorted. */
  readonly excludeEmailValues: readonly string[];
}

export interface FoldGmailProjectionRunResult {
  readonly runId: string;
  readonly reusedRun: boolean;
  readonly profileCount: number;
  /** The kind checksum. This is the run's persisted checksum. */
  readonly checksum: string;
  readonly edgesWritten: number;
  /** Not persisted. The backfill compares it in memory across dry runs. */
  readonly edgeChecksum: string;
}

/**
 * Start or reuse the run for `projectionVersion`, fold kinds and `works_at` edges,
 * write the Gmail cursor, and complete the run, all in `tx`. The caller may
 * throw after this returns to roll the whole run back.
 */
export async function foldGmailProjectionRun(
  args: FoldGmailProjectionRunArgs,
  tx: DbTransaction,
): Promise<FoldGmailProjectionRunResult> {
  const gmailHighWatermark = args.sourceHighWatermark.gmail;

  const started = await startProjectionRun(
    {
      userId: args.userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: args.projectionVersion,
      sourceHighWatermark: args.sourceHighWatermark,
    },
    tx,
  );

  // A reused run keeps the prior attempt's rows. Delete them before the folds write again.
  if (started.reused) {
    await tx
      .delete(entityProfiles)
      .where(
        and(
          eq(entityProfiles.userId, args.userId),
          eq(entityProfiles.projectionRunId, started.run.id),
        ),
      );
    await tx
      .delete(entityEdges)
      .where(
        and(eq(entityEdges.userId, args.userId), eq(entityEdges.projectionRunId, started.run.id)),
      );
  }

  const foldArgs = {
    userId: args.userId,
    projectionRunId: started.run.id,
    projectionVersion: args.projectionVersion,
    gmailHighWatermark,
    excludeEmailValues: args.excludeEmailValues,
  };

  const projected = await projectGmailKindProfiles(foldArgs, tx);
  const edged = await projectGmailWorksAtEdges(foldArgs, tx);

  if (gmailHighWatermark) {
    await writeProjectionCursor(
      {
        userId: args.userId,
        projectionName: USER_MODEL_PROJECTION_NAME,
        projectionVersion: args.projectionVersion,
        projectionRunId: started.run.id,
        source: "gmail",
        cursor: gmailHighWatermark,
      },
      tx,
    );
  }

  await completeProjectionRun(
    {
      runId: started.run.id,
      userId: args.userId,
      // Persist the kind checksum only. The refold drift gate recomputes only the
      // kind fold, so an edge-inclusive checksum would block every refold as logic drift.
      checksum: projected.checksum,
      completedAt: new Date(),
      rowCounts: {
        entity_profiles: projected.profileCount,
        entity_edges: edged.edgesWritten,
      },
      sourceHighWatermark: args.sourceHighWatermark,
    },
    tx,
  );

  return {
    runId: started.run.id,
    reusedRun: started.reused,
    profileCount: projected.profileCount,
    checksum: projected.checksum,
    edgesWritten: edged.edgesWritten,
    edgeChecksum: edged.checksum,
  };
}
