import {
  skillRevisions,
  skillRuns,
  skills,
  type Skill,
  type SkillRevision,
  type SkillRun,
} from "@alfred/db/schemas";
import { asc, eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

export const fetchSkills = syncEntity("skill", {
  query: (tx, userId) =>
    tx.select().from(skills).where(eq(skills.userId, userId)).orderBy(asc(skills.id)),
  map: (s: Skill) => s,
});

export const fetchSkillRevisions = syncEntity("skillrev", {
  query: (tx, userId) =>
    tx
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.userId, userId))
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

export const fetchSkillRuns = syncEntity("skillrun", {
  query: (tx, userId) =>
    tx.select().from(skillRuns).where(eq(skillRuns.userId, userId)).orderBy(asc(skillRuns.id)),
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
