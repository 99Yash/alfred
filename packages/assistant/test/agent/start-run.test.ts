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
import type { StepResult, Workflow } from "@alfred/assistant/execution";
import { dbBackedSkip } from "../support/db-backed";

/**
 * One `startRun` both persists a `pending` row and enqueues its job.
 * Keep `-direct-` in the id prefix: a bare `test-start-run-` would make the
 * `before` cleanup delete the concurrent in-tx suite's rows (`check:test-id-prefixes`).
 */
const SKIP = dbBackedSkip("database+redis");

const SERVER_ENV_FIXTURES = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
  // `serverEnv()` requires a 32-byte credential KEK in every environment.
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
} satisfies Record<string, string>;

const SLUG = "__test-start-run";

const ID_PREFIX = "test-start-run-direct-";

const createdUserIds: string[] = [];

const createdRunIds: string[] = [];

function seedServerEnvForQueueTests(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

// Its step never runs.
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
