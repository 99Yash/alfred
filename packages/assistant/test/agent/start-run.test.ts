import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";

import { getPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { closeAgentQueue, getAgentQueue } from "@alfred/assistant/execution/queue";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { startRun } from "@alfred/assistant/execution/service";
import type { StepResult, Workflow } from "@alfred/assistant/execution/types";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB/Redis-backed coverage for the execution module's `startRun` seam
 * (campaign item 01). `startRun` folds `createRun` (persist a `pending` row)
 * and `enqueueRun` (hand the run to the worker) into one call so an ordinary
 * caller cannot persist a run and forget to enqueue it. This test pins both
 * halves: after one `startRun`, the `agent_runs` row exists in `pending` AND a
 * BullMQ job carrying its `runId` sits on the agent queue.
 *
 * Opt-in: runs only when `DATABASE_URL` and `REDIS_URL` point at reachable test
 * services. Seeds a throwaway `test-start-run-*` user and cascades it away on
 * teardown. The agent worker never runs here, so the enqueued job is inspected
 * and removed directly.
 */
const SKIP = dbBackedSkip("database+redis");

const SERVER_ENV_FIXTURES: Record<string, string> = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
  // #453: `serverEnv()` requires a 32-byte credential KEK in every environment.
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
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
};

const SLUG = "__test-start-run";
const ID_PREFIX = "test-start-run-";
const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

function seedServerEnvForQueueTests(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

// A trivial registered recipe. Its step is never executed: this test asserts
// persist+enqueue, not step run.
const startRunTestRecipe: Workflow<unknown> = {
  slug: SLUG,
  name: "start-run test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: "noop",
  closure: { kind: "none" },
  steps: {
    noop: {
      id: "noop",
      run: async (): Promise<StepResult<unknown>> => ({ kind: "done", state: {}, output: {} }),
    },
  },
};

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function queuedAgentRunIds(): Promise<Set<string>> {
  const queue = getAgentQueue();
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500);
  const runIds = new Set<string>();
  for (const job of jobs) {
    const runId = getPath(job.data, "runId");
    if (typeof runId === "string") runIds.add(runId);
  }
  return runIds;
}

async function removeQueuedAgentRuns(): Promise<void> {
  const queue = getAgentQueue();
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500);
  await Promise.all(
    jobs.map(async (job) => {
      const runId = getPath(job.data, "runId");
      if (typeof runId === "string" && createdRunIds.includes(runId)) {
        await job.remove();
      }
    }),
  );
}

describe("startRun persists then enqueues (DB/Redis-backed)", { skip: SKIP }, () => {
  before(async () => {
    seedServerEnvForQueueTests();
    if (!getWorkflow(SLUG)) registerRecipe(startRunTestRecipe);
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  afterEach(async () => {
    await removeQueuedAgentRuns();
  });

  after(async () => {
    _resetRegistryForTests();
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeAgentQueue();
    await closeRedis();
    await closeConnections();
  });

  test("one startRun call leaves a pending run row and a queued job for it", async () => {
    const userId = await seedUser();

    const { runId, created } = await startRun({
      userId,
      workflowSlug: SLUG,
      trigger: { kind: "manual" },
      occurrence: { kind: "manual", requestId: randomUUID() },
    });
    createdRunIds.push(runId);

    assert.equal(created, true);

    const rows = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    assert.equal(rows.length, 1, "expected exactly one agent_runs row");
    assert.equal(rows[0]?.status, "pending", "run row should be pending after startRun");

    const queued = await queuedAgentRunIds();
    assert.equal(queued.has(runId), true, `expected agent queue to contain run ${runId}`);
  });
});
