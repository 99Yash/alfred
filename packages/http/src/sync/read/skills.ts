import {
  skillRevisions,
  skillRuns,
  skills,
  type Skill,
  type SkillRevision,
  type SkillRun,
} from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

export const fetchSkills = syncEntity(SYNC_MODEL.skill, {
  versionQuery: (tx, userId) =>
    tx
      .select({ id: skills.id, rowVersion: skills.rowVersion })
      .from(skills)
      .where(eq(skills.userId, userId))
      .orderBy(asc(skills.id)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.userId, userId),
          inArray(
            skills.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(skills.id)),
  map: (s: Skill) => s,
});

export const fetchSkillRevisions = syncEntity(SYNC_MODEL.skillrev, {
  versionQuery: (tx, userId) =>
    tx
      .select({ id: skillRevisions.id, rowVersion: skillRevisions.rowVersion })
      .from(skillRevisions)
      .where(eq(skillRevisions.userId, userId))
      .orderBy(asc(skillRevisions.id)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(skillRevisions)
      .where(
        and(
          eq(skillRevisions.userId, userId),
          inArray(
            skillRevisions.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(skillRevisions.id)),
  map: (r: SkillRevision) => ({
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    body: r.body,
    metadata: r.metadata,
    createdByRunId: r.createdByRunId,
    rowVersion: r.rowVersion,
    createdAt: r.createdAt,
  }),
});

export const fetchSkillRuns = syncEntity(SYNC_MODEL.skillrun, {
  versionQuery: (tx, userId) =>
    tx
      .select({ id: skillRuns.id, rowVersion: skillRuns.rowVersion })
      .from(skillRuns)
      .where(eq(skillRuns.userId, userId))
      .orderBy(asc(skillRuns.id)),
  loadQuery: (tx, userId, changed) =>
    tx
      .select()
      .from(skillRuns)
      .where(
        and(
          eq(skillRuns.userId, userId),
          inArray(
            skillRuns.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(skillRuns.id)),
  map: (r: SkillRun) => ({
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    agentRunId: r.agentRunId,
    status: r.status,
    producedRevisionId: r.producedRevisionId,
    rowVersion: r.rowVersion,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  }),
});
