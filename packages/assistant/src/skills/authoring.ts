import { randomUUID } from "node:crypto";
import { Errors } from "@alfred/contracts";
import { db } from "@alfred/db";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { skills } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { startRun } from "@alfred/assistant/execution";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { recordSkillRun } from "./revisions";
import { slugifyForUser } from "./slug";
import {
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  type LearnSkillWorkflowInput,
} from "./workflow-input";

export interface CreateSkillArgs {
  userId: string;
  /** Blank or absent names become "Untitled skill". */
  name?: string | undefined;
  /** Blank or absent makes an empty draft with no learn run. */
  prompt?: string | undefined;
}

export interface CreatedSkill {
  skillId: string;
  slug: string;
  runId: string | null;
}

/** Insert a draft skill, then start its first learn run when a prompt is given. */
export async function createSkill(args: CreateSkillArgs): Promise<CreatedSkill> {
  const rawName = args.name?.trim() ?? "";
  const name = rawName.length > 0 ? rawName : "Untitled skill";
  const slug = await slugifyForUser(args.userId, name);

  const inserted = await db()
    .insert(skills)
    .values({
      userId: args.userId,
      slug,
      name,
      status: "draft",
      currentRevisionId: null,
      isBuiltin: false,
    })
    .returning({ id: skills.id, slug: skills.slug });

  const skill = inserted[0];

  if (!skill) throw Errors.InternalServerError("Failed to insert skill");

  const prompt = args.prompt?.trim() ?? "";

  if (prompt.length === 0) {
    /* Poke so the client has the row before its detail page renders. */
    emitReplicachePokes([args.userId], skill.id);

    return { skillId: skill.id, slug: skill.slug, runId: null };
  }

  const runId = await startLearnRun({
    userId: args.userId,
    input: { skillId: skill.id, prompt, reason: "manual" },
    requestId: `initial:${skill.id}`,
  });

  return { skillId: skill.id, slug: skill.slug, runId };
}

export interface RelearnSkillArgs {
  userId: string;
  skillId: string;
  prompt: string;
}

export type RelearnSkillOutcome =
  | { kind: "started"; runId: string }
  /** A learn run for this skill holds the dedup index; `dedupKey` names it. */
  | { kind: "in_flight"; dedupKey: string }
  /** No skill with this id belongs to the user. */
  | { kind: "not_found" };

/** Start a regenerate learn run on a skill the user owns. At most one runs per skill. */
export async function relearnSkill(args: RelearnSkillArgs): Promise<RelearnSkillOutcome> {
  const owner = await db()
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.id, args.skillId), eq(skills.userId, args.userId)))
    .limit(1);

  if (!owner[0]) return { kind: "not_found" };

  try {
    const runId = await startLearnRun({
      userId: args.userId,
      input: { skillId: args.skillId, prompt: args.prompt, reason: "regen" },
      requestId: randomUUID(),
    });

    return { kind: "started", runId };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { kind: "in_flight", dedupKey: learnSkillDedupKey(args.skillId) };
    }

    throw err;
  }
}

/**
 * Enqueue `learn-skill`, then record the `skill_runs` row so the UI shows "in progress".
 * `gather` re-records it idempotently, so enqueue before this commit is safe.
 */
async function startLearnRun(args: {
  userId: string;
  input: LearnSkillWorkflowInput;
  requestId: string;
}): Promise<string> {
  const created = await startRun({
    userId: args.userId,
    workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
    input: args.input,
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: args.requestId },
  });

  await recordSkillRun({
    userId: args.userId,
    skillId: args.input.skillId,
    kind: "learn",
    agentRunId: created.runId,
  });

  return created.runId;
}
