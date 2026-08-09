import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { closeAgentQueue, getAgentQueue } from "../../src/modules/agent/queue";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "../../src/modules/agent/registry";
import { createRun, startRunInTx } from "../../src/modules/agent/service";
import type { CreateRunArgs } from "../../src/modules/agent/service";
import type { StepResult, Workflow } from "../../src/modules/agent/types";

/**
 * DB/Redis-backed coverage for the execution module's `startRunInTx` seam
 * (campaign item 05). `startRunInTx` owns the occurrence-claim path: it runs the
 * caller's `claim` (CAS + other durable writes) on one transaction, creates the
 * run on that same transaction, and enqueues once AFTER the transaction commits.
 * The queue handle never leaves execution, so a caller cannot split, re-order, or
 * drop the deliver. This test pins three properties:
 *
 *  1. `claim` returns `null` (raced) → resolves `null`, no run row, no queued job.
 *  2. `claim` returns args → the run row is created on the transaction and a
 *     BullMQ job with the passed `jobId` sits on the queue only AFTER commit
 *     (the job is absent while `claim` still runs).
 *  3. `claim` throws → the transaction rolls back (no run row) and no job fires.
 *
 * Opt-in: runs only when `DATABASE_URL` and `REDIS_URL` point at reachable test
 * services. Seeds a throwaway `test-start-run-in-tx-*` user and cascades it away.
 */
const HAS_DB_AND_REDIS = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const SKIP = HAS_DB_AND_REDIS
  ? false
  : "DATABASE_URL/REDIS_URL not set — skipping DB/Redis-backed test";

const SERVER_ENV_FIXTURES: Record<string, string> = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
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

const SLUG = "__test-start-run-in-tx";
const ID_PREFIX = "test-start-run-in-tx-";
const createdUserIds: string[] = [];
const createdJobIds: string[] = [];

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

async function queueHasJobId(jobId: string): Promise<boolean> {
  const queue = getAgentQueue();
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500);
  return jobs.some((job) => job.id === jobId);
}

async function runRowCountForUser(userId: string): Promise<number> {
  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId));
  return rows.length;
}

async function removeCreatedJobs(): Promise<void> {
  const queue = getAgentQueue();
  await Promise.all(
    createdJobIds.map(async (jobId) => {
      const job = await queue.getJob(jobId);
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
    await closeAgentQueue();
    await closeRedis();
    await closeConnections();
  });

  test("claim returning null resolves null with no run row and no queued job", async () => {
    const userId = await seedUser();
    const jobId = `${ID_PREFIX}raced.${randomUUID()}`;
    createdJobIds.push(jobId);

    const result = await startRunInTx({
      claim: async () => null,
      enqueue: { jobId },
    });

    assert.equal(result, null, "raced claim should resolve null");
    // No run row proves `createRun` never ran: it is the only path that inserts
    // an `agent_runs` row, and `startRunInTx` skips it on a null claim.
    assert.equal(await runRowCountForUser(userId), 0, "no run row for a raced claim");
    assert.equal(await queueHasJobId(jobId), false, "no queued job for a raced claim");
  });

  test("claim returning args creates the run and enqueues only after commit", async () => {
    const userId = await seedUser();
    const jobId = `${ID_PREFIX}committed.${randomUUID()}`;
    createdJobIds.push(jobId);

    let enqueuedWhileClaimRan: boolean | undefined;
    const result = await startRunInTx({
      claim: async () => {
        // The enqueue must fire AFTER the transaction commits, so while `claim`
        // still runs the job cannot yet be on the queue.
        enqueuedWhileClaimRan = await queueHasJobId(jobId);
        return runArgsFor(userId);
      },
      enqueue: { jobId },
    });

    assert.ok(result, "committed claim should resolve a run result");
    assert.equal(result?.created, true);
    assert.equal(enqueuedWhileClaimRan, false, "enqueue must not fire before commit");

    const rows = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, result.runId));
    assert.equal(rows.length, 1, "expected exactly one agent_runs row");
    assert.equal(rows[0]?.status, "pending", "run row should be pending after commit");
    assert.equal(await queueHasJobId(jobId), true, "expected the passed jobId on the queue");
  });

  test("claim throwing rolls back the run row and fires no job", async () => {
    const userId = await seedUser();
    const jobId = `${ID_PREFIX}rollback.${randomUUID()}`;
    createdJobIds.push(jobId);

    await assert.rejects(
      startRunInTx({
        claim: async (tx) => {
          // Persist a run on the transaction, then fail: the row must not
          // survive and the enqueue must never fire.
          await createRun(runArgsFor(userId), tx);
          throw new Error("claim failed after a durable write");
        },
        enqueue: { jobId },
      }),
      /claim failed after a durable write/,
    );

    assert.equal(await runRowCountForUser(userId), 0, "the tx write must roll back");
    assert.equal(await queueHasJobId(jobId), false, "no job fires when claim throws");
  });
});
