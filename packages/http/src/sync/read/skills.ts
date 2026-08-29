import {
  skillRevisions,
  skillRuns,
  skills,
  type Skill,
  type SkillRevision,
  type SkillRun,
} from "@alfred/db/schemas";
import {
  syncedSkillRevisionSchema,
  syncedSkillRunSchema,
  syncedSkillSchema,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

const serializeSkill = defineSerializer<Skill, SyncedSkill>(syncedSkillSchema);

const serializeSkillRevision = defineSerializer<SkillRevision, SyncedSkillRevision>(
  syncedSkillRevisionSchema,
);

const serializeSkillRun = defineSerializer<SkillRun, SyncedSkillRun>(syncedSkillRunSchema);

export const fetchSkills = defineFetcher<Skill>({
  slug: "SKILL",
  query: (tx, userId) =>
    tx.select().from(skills).where(eq(skills.userId, userId)).orderBy(asc(skills.id)),
  idOf: (s) => s.id,
  versionOf: (s) => s.rowVersion,
  serialize: serializeSkill,
});

export const fetchSkillRevisions = defineFetcher<SkillRevision>({
  slug: "SKILL_REVISION",
  query: (tx, userId) =>
    tx
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.userId, userId))
      .orderBy(asc(skillRevisions.id)),
  idOf: (r) => r.id,
  versionOf: (r) => r.rowVersion,
  serialize: serializeSkillRevision,
});

export const fetchSkillRuns = defineFetcher<SkillRun>({
  slug: "SKILL_RUN",
  query: (tx, userId) =>
    tx.select().from(skillRuns).where(eq(skillRuns.userId, userId)).orderBy(asc(skillRuns.id)),
  idOf: (r) => r.id,
  versionOf: (r) => r.rowVersion,
  serialize: serializeSkillRun,
});
