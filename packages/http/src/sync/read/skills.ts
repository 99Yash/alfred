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

export const fetchSkills = syncEntity<"SKILL", Skill>("SKILL", {
  query: (tx, userId) =>
    tx.select().from(skills).where(eq(skills.userId, userId)).orderBy(asc(skills.id)),
  map: (s) => s,
});

export const fetchSkillRevisions = syncEntity<"SKILL_REVISION", SkillRevision>("SKILL_REVISION", {
  query: (tx, userId) =>
    tx
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.userId, userId))
      .orderBy(asc(skillRevisions.id)),
  map: (r) => r,
});

export const fetchSkillRuns = syncEntity<"SKILL_RUN", SkillRun>("SKILL_RUN", {
  query: (tx, userId) =>
    tx.select().from(skillRuns).where(eq(skillRuns.userId, userId)).orderBy(asc(skillRuns.id)),
  map: (r) => r,
});
