import { db } from "@alfred/db";
import { skillRevisions, skillRuns, skills } from "@alfred/db/schemas";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { emitReplicachePokes } from "../../events/replicache-events";

/**
 * Append a `skill_revisions` row, advance `skills.current_revision_id`,
 * and (optionally) refresh the skill's display name + status — all in
 * one transaction so a partial commit can never leave a skill pointing
 * at a revision that doesn't exist.
 *
 * `kind` discriminates the producer:
 *   - `distilled`  — sync output of `learn-skill`. The first revision
 *                    flips a `draft` skill to `active`.
 *   - `documented` — async output of `skill-documentation`. Updates
 *                    `current_revision_id` but leaves `status` alone.
 *   - `manual`     — direct edit via the markdown editor. No agent run.
 */
export interface CommitRevisionArgs {
  userId: string;
  skillId: string;
  kind: "distilled" | "documented" | "manual";
  body: string;
  metadata?: Record<string, unknown>;
  /** Pointer to `agent_runs.id`. Required for distilled/documented; null for manual. */
  createdByRunId?: string | null;
  /** When set, also overwrites `skills.name`. Distill uses this for the auto-title. */
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
      throw new Error(`[learn-skill] skill not found or not owned by user: ${args.skillId}`);
    }

    const createdByRunId = args.createdByRunId ?? null;

    // Idempotent on (skillId, createdByRunId) via the partial unique
    // `skill_revisions_run_idx`. A step retry that re-enters commit after the
    // row already committed hits the conflict and inserts nothing, so we fall
    // back to the existing row and skip the pointer/rowVersion update below —
    // re-running that would double-bump `row_version` and defeat optimistic-
    // concurrency consumers. `manual` edits carry a null run id (outside the
    // partial index), so they never conflict and always append. The arbiter
    // `where` must restate the index predicate or Postgres can't match the
    // partial index for the ON CONFLICT clause.
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
      // Conflict (createdByRunId is non-null): this run already committed its
      // revision on a prior attempt. Return the existing pointer untouched —
      // the first attempt already advanced `current_revision_id` and bumped
      // `row_version`, so we must not touch the skill row again.
      const [existing] = await tx
        .select({ id: skillRevisions.id })
        .from(skillRevisions)
        .where(
          and(
            eq(skillRevisions.skillId, args.skillId),
            eq(skillRevisions.createdByRunId, createdByRunId as string),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error(
          `[learn-skill] revision insert conflicted but no row found for run ${createdByRunId}`,
        );
      }
      return { revisionId: existing.id, skillStatus: skill.status, created: false };
    }

    // First revision flips draft → active. Subsequent revisions only
    // touch the pointer; documentation / manual edits don't reset state.
    const flippingFromDraft = args.kind === "distilled" && skill.status === "draft";
    const updatePatch: Record<string, unknown> = {
      currentRevisionId: revision.id,
      rowVersion: sql`${skills.rowVersion} + 1`,
    };
    if (args.newName) updatePatch.name = args.newName;
    if (flippingFromDraft) updatePatch.status = "active";

    await tx.update(skills).set(updatePatch).where(eq(skills.id, args.skillId));

    return {
      revisionId: revision.id,
      skillStatus: flippingFromDraft ? "active" : skill.status,
      created: true,
    };
  });

  // The revision and skill pointer are now visible to Replicache pulls. Do not
  // poke on an idempotent retry that found the run's existing revision.
  if (result.created) emitReplicachePokes([args.userId], args.skillId);
  return { revisionId: result.revisionId, skillStatus: result.skillStatus };
}

/**
 * Insert / update the per-Learn-click run record. `kind` matches the
 * workflow slug intent (`learn` for `learn-skill`, `document` for
 * `skill-documentation`). Returns the row id; status updates are
 * caller-driven via {@link finalizeSkillRun}.
 */
export interface RecordSkillRunArgs {
  userId: string;
  skillId: string;
  kind: "learn" | "document";
  agentRunId: string;
}

export async function recordSkillRun(args: RecordSkillRunArgs): Promise<{ id: string }> {
  // Idempotent on (agent_run_id) via the unique index. Atomic upsert
  // matches the pattern used in notify() — a concurrent caller can't
  // slip between a select-then-insert and trip the unique index.
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
    throw new Error(`[learn-skill] skill_runs upsert conflicted but no row found on lookup`);
  }
  return existing;
}

/** Mark a `skill_runs` row terminal. Idempotent: a second call is a no-op. */
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
