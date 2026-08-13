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
  (process.env.REDIS_URL
    ? "REDIS_URL set - local poke assertions require the in-process bridge"
    : false);

// The prefix-only throw path needs a DB row absence, not the in-process poke
// bridge, so it runs whether or not REDIS_URL is set — a strictly weaker gate
// than SKIP above.
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
  // `skill-revisions` is a phase-neutral persistence leaf called by both the
  // `distilled` (learn-skill) and `documented` (skill-documentation) consumers.
  // Its thrown errors must name the module owner, never one consumer, so a
  // `documented` failure is not mis-triaged to the learn phase.
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

// Both suites share the lazily-created singleton `db()` pool. `closeConnections`
// is not idempotent (`pool.end()` twice throws), so close it exactly once here,
// after every suite in the process has run, rather than per-suite.
after(async () => {
  await closeConnections();
});
