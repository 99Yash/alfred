import {
  skillRevisions,
  skillRuns,
  skills,
  type Skill,
  type SkillRevision,
  type SkillRun,
} from "@alfred/db/schemas";
import {
  jsonRecordSchema,
  syncedSkillRevisionSchema,
  syncedSkillRunSchema,
  syncedSkillSchema,
  type SyncedSkill,
  type SyncedSkillRevision,
  type SyncedSkillRun,
} from "@alfred/sync";
import { asc, eq } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

export const fetchSkills: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(skills)
    .where(eq(skills.userId, userId))
    .orderBy(asc(skills.id));
  return rows.flatMap((s: Skill) =>
    toEntityRow({
      slug: "SKILL",
      id: s.id,
      rowVersion: s.rowVersion,
      serialize: () => serializeSkill(s),
    }),
  );
};

export const fetchSkillRevisions: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.userId, userId))
    .orderBy(asc(skillRevisions.id));
  return rows.flatMap((r: SkillRevision) =>
    toEntityRow({
      slug: "SKILL_REVISION",
      id: r.id,
      rowVersion: r.rowVersion,
      serialize: () => serializeSkillRevision(r),
    }),
  );
};

export const fetchSkillRuns: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(skillRuns)
    .where(eq(skillRuns.userId, userId))
    .orderBy(asc(skillRuns.id));
  return rows.flatMap((r: SkillRun) =>
    toEntityRow({
      slug: "SKILL_RUN",
      id: r.id,
      rowVersion: r.rowVersion,
      serialize: () => serializeSkillRun(r),
    }),
  );
};

function serializeSkill(s: Skill): SyncedSkill {
  return syncedSkillSchema.parse({
    id: s.id,
    userId: s.userId,
    slug: s.slug,
    name: s.name,
    description: s.description,
    currentRevisionId: s.currentRevisionId,
    status: s.status,
    isBuiltin: s.isBuiltin,
    lastInvokedAt: toIso(s.lastInvokedAt),
    rowVersion: s.rowVersion,
    createdAt: toRequiredIso(s.createdAt, "skills.createdAt"),
    updatedAt: toIso(s.updatedAt),
  });
}

function serializeSkillRevision(r: SkillRevision): SyncedSkillRevision {
  return syncedSkillRevisionSchema.parse({
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    body: r.body,
    metadata: jsonRecordSchema.parse(r.metadata),
    createdByRunId: r.createdByRunId,
    rowVersion: r.rowVersion,
    createdAt: toRequiredIso(r.createdAt, "skillRevisions.createdAt"),
  });
}

function serializeSkillRun(r: SkillRun): SyncedSkillRun {
  return syncedSkillRunSchema.parse({
    id: r.id,
    skillId: r.skillId,
    userId: r.userId,
    kind: r.kind,
    agentRunId: r.agentRunId,
    status: r.status,
    producedRevisionId: r.producedRevisionId,
    rowVersion: r.rowVersion,
    startedAt: toRequiredIso(r.startedAt, "skillRuns.startedAt"),
    endedAt: toIso(r.endedAt),
  });
}
