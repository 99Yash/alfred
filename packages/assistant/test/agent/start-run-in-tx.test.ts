import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { agentQueue } from "@alfred/assistant/execution/queue";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { createRun, startRunInTx } from "@alfred/assistant/execution/service";
import type { CreateRunArgs } from "@alfred/assistant/execution/service";
import type { StepResult, Workflow } from "@alfred/assistant/execution";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `startRunInTx` runs the caller's `claim` and creates the run in one transaction,
 * then enqueues only after commit. A null or throwing claim leaves no row and no job.
 */
const SKIP = dbBackedSkip("database+redis");

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

const SLUG = "__test-start-run-in-tx";

const ID_PREFIX = "test-start-run-in-tx-";

const createdUserIds: string[] = [];

/** Runs whose `start` job a test may have added. */
const startedRunIds: string[] = [];

function seedServerEnvForQueueTests(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

const testRecipe: Workflow<unknown> = {
  slug: SLUG,
  name: "start-run-in-tx test",
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

function runArgsFor(userId: string): CreateRunArgs {
  return {
    userId,
    workflowSlug: SLUG,
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  };
}

/** The ids of the queued `start` jobs: the kind that `enqueue: "once"` adds. */
async function queuedStartJobIds(): Promise<Set<string>> {
  const jobs = await agentQueue
    .inspect()
    .getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500);

  return new Set(jobs.flatMap((job) => (job.name === "start" && job.id ? [job.id] : [])));
}

async function runRowCountForUser(userId: string): Promise<number> {
  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId));

  return rows.length;
}

async function removeCreatedJobs(): Promise<void> {
  await Promise.all(
    startedRunIds.map(async (runId) => {
      const job = await agentQueue.getJob("start", { runId });

      if (job) await job.remove();
    }),
  );
}

describe("startRunInTx claims, persists, then enqueues (DB/Redis-backed)", { skip: SKIP }, () => {
  before(async () => {
    seedServerEnvForQueueTests();

    if (!getWorkflow(SLUG)) registerRecipe(testRecipe);
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  afterEach(async () => {
    await removeCreatedJobs();
  });

  after(async () => {
    _resetRegistryForTests();

    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await agentQueue.close();
    await closeRedis();
    await closeConnections();
  });

  test("claim returning null resolves null with no run row and no queued job", async () => {
    const userId = await seedUser();
    const before = await queuedStartJobIds();

    const result = await startRunInTx({
      claim: async () => null,
      enqueue: "once",
    });

    assert.equal(result, null, "raced claim should resolve null");
    assert.equal(await runRowCountForUser(userId), 0, "no run row for a raced claim");
    const added = [...(await queuedStartJobIds())].filter((id) => !before.has(id));
    assert.deepEqual(added, [], "no queued job for a raced claim");
  });

  test("claim returning args creates the run and enqueues only after commit", async () => {
    const userId = await seedUser();

    let queuedWhileClaimRan: Set<string> | undefined;

    const result = await startRunInTx({
      claim: async () => {
        queuedWhileClaimRan = await queuedStartJobIds();

        return runArgsFor(userId);
      },
      enqueue: "once",
    });

    assert.ok(result, "committed claim should resolve a run result");
    assert.equal(result.created, true);
    startedRunIds.push(result.runId);
    const jobId = agentQueue.jobId("start", { runId: result.runId });
    assert.equal(jobId, `run-start.${result.runId}`);
    assert.equal(queuedWhileClaimRan?.has(jobId), false, "enqueue must not fire before commit");

    const rows = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, result.runId));

    assert.equal(rows.length, 1, "expected exactly one agent_runs row");
    assert.equal(rows[0]?.status, "pending", "run row should be pending after commit");
    assert.equal(
      (await queuedStartJobIds()).has(jobId),
      true,
      "expected the run's `start` job on the queue",
    );
  });

  test("claim throwing rolls back the run row and fires no job", async () => {
    const userId = await seedUser();
    let rolledBackRunId: string | undefined;

    await assert.rejects(
      startRunInTx({
        claim: async (tx) => {
          rolledBackRunId = (await createRun(runArgsFor(userId), tx)).runId;
          throw new Error("claim failed after a durable write");
        },
        enqueue: "once",
      }),
      /claim failed after a durable write/,
    );

    assert.equal(await runRowCountForUser(userId), 0, "the tx write must roll back");
    assert.ok(rolledBackRunId, "the claim created a run before it threw");
    startedRunIds.push(rolledBackRunId);
    const jobId = agentQueue.jobId("start", { runId: rolledBackRunId });
    assert.equal((await queuedStartJobIds()).has(jobId), false, "no job fires when claim throws");
  });
});
