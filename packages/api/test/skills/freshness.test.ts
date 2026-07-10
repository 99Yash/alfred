import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { skillRuns, skills, user } from "@alfred/db/schemas";
import { eq, inArray } from "drizzle-orm";

import { subscribeUserPokes } from "../../src/events/replicache-events";
import {
  commitSkillRevision,
  finalizeSkillRun,
  recordSkillRun,
} from "../../src/modules/skills/revisions";

const SKIP = process.env.DATABASE_URL
  ? process.env.REDIS_URL
    ? "REDIS_URL set - local poke assertions require the in-process bridge"
    : false
  : "DATABASE_URL not set - skipping DB-backed test";

const createdUserIds: string[] = [];

async function seedSkill(): Promise<{ userId: string; skillId: string }> {
  const userId = `test-skill-fresh-${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const [skill] = await db()
    .insert(skills)
    .values({ userId, slug: `skill-${randomUUID()}`, name: "Fresh skill" })
    .returning({ id: skills.id });
  assert.ok(skill);
  return { userId, skillId: skill.id };
}

describe("skill Replicache freshness (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("revision commit pokes once after the idempotent write", async () => {
    const { userId, skillId } = await seedSkill();
    const pokes: string[] = [];
    const unsubscribe = subscribeUserPokes(userId, (poke) => pokes.push(poke.assetId));
    const runId = `run_${randomUUID()}`;

    const first = await commitSkillRevision({
      userId,
      skillId,
      kind: "distilled",
      body: "# Learned",
      createdByRunId: runId,
    });
    const retry = await commitSkillRevision({
      userId,
      skillId,
      kind: "distilled",
      body: "# Learned",
      createdByRunId: runId,
    });

    unsubscribe();
    assert.equal(retry.revisionId, first.revisionId);
    assert.deepEqual(pokes, [skillId]);
  });

  test("run creation and one terminal transition each poke once", async () => {
    const { userId, skillId } = await seedSkill();
    const pokes: string[] = [];
    const unsubscribe = subscribeUserPokes(userId, (poke) => pokes.push(poke.assetId));
    const agentRunId = `run_${randomUUID()}`;

    await recordSkillRun({ userId, skillId, kind: "learn", agentRunId });
    await recordSkillRun({ userId, skillId, kind: "learn", agentRunId });
    await finalizeSkillRun({ agentRunId, status: "failed" });
    await finalizeSkillRun({ agentRunId, status: "failed" });

    unsubscribe();
    assert.deepEqual(pokes, [skillId, skillId]);
    const [run] = await db()
      .select({ status: skillRuns.status, rowVersion: skillRuns.rowVersion })
      .from(skillRuns)
      .where(eq(skillRuns.agentRunId, agentRunId));
    assert.deepEqual(run, { status: "failed", rowVersion: 1 });
  });
});
