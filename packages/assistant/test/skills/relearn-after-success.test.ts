import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { getStringPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import { agentRuns, skills, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { agentQueue } from "@alfred/assistant/execution/queue";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { relearnSkill } from "../../src/skills/authoring";
import { learnSkillWorkflow } from "../../src/skills/learn-skill";
import { LEARN_SKILL_WORKFLOW_SLUG } from "../../src/skills/workflow-input";
import { dbBackedSkip } from "../support/db-backed";

// SM-03 in docs/reference/state-machines.md: the Learn key blocks only a concurrent run.
// A completed Learn must not refuse every later Regenerate as "in flight".

const SKIP = dbBackedSkip("database+redis");

const ID_PREFIX = "test-relearn-after-success-";

const SERVER_ENV_FIXTURES = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "test-cf-token",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_GATEWAY_ID: "test-cf-gateway",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
} satisfies Record<string, string>;

const createdUserIds: string[] = [];

const createdRunIds: string[] = [];

async function seedSkill(): Promise<{ userId: string; skillId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Relearn Test", email: `${userId}@example.test` });

  const [row] = await db()
    .insert(skills)
    .values({ userId, slug: `skill-${randomUUID()}`, name: "Test skill" })
    .returning({ id: skills.id });

  assert.ok(row);

  return { userId, skillId: row.id };
}

async function setRunStatus(runId: string, status: "completed" | "running"): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ status, ...(status === "completed" ? { endedAt: new Date() } : {}) })
    .where(eq(agentRuns.id, runId));
}

describe("Regenerate after a completed Learn (DB/Redis-backed)", { skip: SKIP }, () => {
  before(async () => {
    for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
      process.env[key] ??= value;
    }

    if (!getWorkflow(LEARN_SKILL_WORKFLOW_SLUG)) registerRecipe(learnSkillWorkflow);
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    const queue = agentQueue.inspect();
    const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500);
    await Promise.all(
      jobs
        .filter((job) => createdRunIds.includes(getStringPath(job.data, "runId") ?? ""))
        .map((job) => job.remove()),
    );

    _resetRegistryForTests();

    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await agentQueue.close();
    await closeRedis();
    await closeConnections();
  });

  test("a completed Learn frees the key for the next Regenerate", async () => {
    const { userId, skillId } = await seedSkill();

    const first = await relearnSkill({ userId, skillId, prompt: "learn it" });
    assert.equal(first.kind, "started");
    createdRunIds.push(first.runId);
    await setRunStatus(first.runId, "completed");

    const second = await relearnSkill({ userId, skillId, prompt: "learn it again" });

    assert.equal(second.kind, "started");
    createdRunIds.push(second.runId);
  });

  test("a live Learn still refuses a concurrent Regenerate", async () => {
    const { userId, skillId } = await seedSkill();

    const first = await relearnSkill({ userId, skillId, prompt: "learn it" });
    assert.equal(first.kind, "started");
    createdRunIds.push(first.runId);
    await setRunStatus(first.runId, "running");

    const second = await relearnSkill({ userId, skillId, prompt: "learn it again" });

    assert.equal(second.kind, "in_flight");
  });
});
