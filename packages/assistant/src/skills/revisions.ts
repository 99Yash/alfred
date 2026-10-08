import type { JsonObject } from "@alfred/contracts";
import { db } from "@alfred/db";
import { skillRevisions, skillRuns, skills } from "@alfred/db/schemas";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";

/**
 * Append a `skill_revisions` row and move `skills.current_revision_id`, in one transaction.
 * `distilled` (from `learn-skill`) flips a `draft` skill to `active` on the first revision.
 * `documented` (from `skill-documentation`) leaves `status` alone. `manual` is an editor save.
 */
export interface CommitRevisionArgs {
  userId: string;
  skillId: string;
  kind: "distilled" | "documented" | "manual";
  body: string;
  metadata?: JsonObject;
  /** Required for distilled and documented; null for manual. */
  createdByRunId?: string | null;
  /** Also overwrites `skills.name`. */
  newName?: string;
}

export interface CommitRevisionResult {
  revisionId: string;
  skillStatus: string;
}

export async function commitSkillRevision(args: CommitRevisionArgs): Promise<CommitRevisionResult> {
  const result = await db().transaction(async (tx) => {
    const [skill] = await tx
      .select({ id: skills.id, status: skills.status })
      .from(skills)
      .where(and(eq(skills.id, args.skillId), eq(skills.userId, args.userId)))
      .limit(1);

    if (!skill) {
      throw new Error(`[skill-revisions] skill not found or not owned by user: ${args.skillId}`);
    }

    const createdByRunId = args.createdByRunId ?? null;

    // Idempotent on (skillId, createdByRunId) via `skill_revisions_run_idx`. A retry finds the
    // row and skips the pointer update, which would double-bump `row_version`.
    // Manual edits have a null run id and always append.
    // The `where` must restate the partial index predicate, or ON CONFLICT cannot use it.
    const [revision] = await tx
      .insert(skillRevisions)
      .values({
        skillId: args.skillId,
        userId: args.userId,
        kind: args.kind,
        body: args.body,
        metadata: args.metadata ?? {},
        createdByRunId,
      })
      .onConflictDoNothing({
        target: [skillRevisions.skillId, skillRevisions.createdByRunId],
        where: sql`${skillRevisions.createdByRunId} IS NOT NULL`,
      })
      .returning({ id: skillRevisions.id });

    if (!revision) {
      // This run already committed on a prior attempt; do not touch the skill row again.
      const [existing] = await tx
        .select({ id: skillRevisions.id })
        .from(skillRevisions)
        .where(
          and(
            eq(skillRevisions.skillId, args.skillId),
            // SAFETY: only a non-manual revision conflicts, and those carry a run id.
            eq(skillRevisions.createdByRunId, createdByRunId as string),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new Error(
          `[skill-revisions] revision insert conflicted but no row found for run ${createdByRunId}`,
        );
      }

      return { revisionId: existing.id, skillStatus: skill.status, created: false };
    }

    // Only the first distilled revision changes status.
    const flippingFromDraft = args.kind === "distilled" && skill.status === "draft";

    const updatePatch = {
      currentRevisionId: revision.id,
      rowVersion: sql`${skills.rowVersion} + 1`,
      ...(args.newName ? { name: args.newName } : {}),
      ...(flippingFromDraft ? { status: "active" as const } : {}),
    };

    await tx.update(skills).set(updatePatch).where(eq(skills.id, args.skillId));

    return {
      revisionId: revision.id,
      skillStatus: flippingFromDraft ? "active" : skill.status,
      created: true,
    };
  });

  // No poke on a retry that found the existing revision.
  if (result.created) emitReplicachePokes([args.userId], args.skillId);

  return { revisionId: result.revisionId, skillStatus: result.skillStatus };
}

/** `kind` is `learn` for `learn-skill` and `document` for `skill-documentation`. */
export interface RecordSkillRunArgs {
  userId: string;
  skillId: string;
  kind: "learn" | "document";
  agentRunId: string;
}

export async function recordSkillRun(args: RecordSkillRunArgs): Promise<{ id: string }> {
  // Atomic upsert on agent_run_id, so concurrent callers cannot both insert.
  const inserted = await db()
    .insert(skillRuns)
    .values({
      skillId: args.skillId,
      userId: args.userId,
      kind: args.kind,
      agentRunId: args.agentRunId,
      status: "running",
    })
    .onConflictDoNothing({ target: skillRuns.agentRunId })
    .returning({ id: skillRuns.id });

  if (inserted[0]) {
    emitReplicachePokes([args.userId], args.skillId);

    return inserted[0];
  }

  const [existing] = await db()
    .select({ id: skillRuns.id })
    .from(skillRuns)
    .where(eq(skillRuns.agentRunId, args.agentRunId))
    .limit(1);

  if (!existing) {
    throw new Error(`[skill-revisions] skill_runs upsert conflicted but no row found on lookup`);
  }

  return existing;
}

/** Idempotent: a second call is a no-op. */
export interface FinalizeSkillRunArgs {
  agentRunId: string;
  status: "completed" | "failed" | "cancelled";
  producedRevisionId?: string;
}

export async function finalizeSkillRun(args: FinalizeSkillRunArgs): Promise<void> {
  const updated = await db()
    .update(skillRuns)
    .set({
      status: args.status,
      producedRevisionId: args.producedRevisionId ?? null,
      endedAt: new Date(),
      rowVersion: sql`${skillRuns.rowVersion} + 1`,
    })
    .where(
      and(
        eq(skillRuns.agentRunId, args.agentRunId),
        notInArray(skillRuns.status, ["completed", "failed", "cancelled"]),
      ),
    )
    .returning({ userId: skillRuns.userId, skillId: skillRuns.skillId });

  const run = updated[0];

  if (run) emitReplicachePokes([run.userId], run.skillId);
}
