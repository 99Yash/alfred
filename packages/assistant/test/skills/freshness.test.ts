import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { skillRuns, skills, user } from "@alfred/db/schemas";
import { eq, inArray } from "drizzle-orm";

import { subscribeUserPokes } from "@alfred/assistant/realtime";
import {
  commitSkillRevision,
  finalizeSkillRun,
  recordSkillRun,
} from "@alfred/assistant/skills/revisions";
import { dbBackedSkip } from "../support/db-backed";

const SKIP =
  dbBackedSkip("database") ||
  // drift-ok: composes an EXTRA condition on top of dbBackedSkip — these poke
  // assertions need REDIS_URL ABSENT, which a presence-only guard cannot express.
  (process.env.REDIS_URL
    ? "REDIS_URL set - local poke assertions require the in-process bridge"
    : false);

// The throw path needs no poke bridge, so it runs with or without REDIS_URL.
const SKIP_DB = dbBackedSkip("database");

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

describe("skill-revisions persistence error prefix (DB-backed)", { skip: SKIP_DB }, () => {
  // Two phases call `skill-revisions`, so its errors name the module, not one phase.
  test("skill-not-found throw names the module owner, not a consumer phase", async () => {
    await assert.rejects(
      commitSkillRevision({
        userId: `test-skill-fresh-${randomUUID()}`,
        skillId: randomUUID(),
        kind: "documented",
        body: "# never committed",
        createdByRunId: `run_${randomUUID()}`,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^\[skill-revisions\] /);
        assert.doesNotMatch(err.message, /learn-skill/);

        return true;
      },
    );
  });
});

// Close the shared pool once: `pool.end()` throws on a second call.
after(async () => {
  await closeConnections();
});
