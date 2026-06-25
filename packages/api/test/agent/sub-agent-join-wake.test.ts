import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { getPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "../../src/queue/connection";
import { closeAgentQueue, getAgentQueue } from "../../src/modules/agent/queue";
import { cancelRun } from "../../src/modules/agent/service";
import {
  SUB_AGENT_WORKFLOW_SLUG,
  subAgentDoneSignalName,
} from "../../src/modules/agent/sub-agent-metadata";
import {
  closeSubAgentJoinWakeQueue,
  getSubAgentJoinWakeQueue,
  scheduleSubAgentJoinWakeJob,
  subAgentJoinWakeJobId,
} from "../../src/modules/agent/sub-agent-join-wake-queue";
import {
  startSubAgentJoinWakeWorker,
  stopSubAgentJoinWakeWorker,
} from "../../src/modules/agent/sub-agent-join-wake-worker";

/**
 * DB/Redis-backed coverage for ADR-0073's liveness guarantee. The unit tests
 * cover the chat-turn guard's dependency-injected seam; these tests exercise
 * the real persisted wake condition, BullMQ delayed wake worker, cancellation
 * wake path, and agent-run enqueue.
 *
 * Opt-in: runs only when `DATABASE_URL` and `REDIS_URL` point at reachable test
 * services. Seeds throwaway `test-sub-agent-join-*` users and cascades them
 * away on teardown.
 */
const HAS_DB_AND_REDIS = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const SKIP = HAS_DB_AND_REDIS
  ? false
  : "DATABASE_URL/REDIS_URL not set — skipping DB/Redis-backed test";

const SERVER_ENV_FIXTURES: Record<string, string> = {
  BETTER_AUTH_SECRET: "test better auth secret with length",
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

const ID_PREFIX = "test-sub-agent-join-";
const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

function seedServerEnvForQueueTests(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

interface SeedJoinRowsResult {
  userId: string;
  parentRunId: string;
  childRunId: string;
}

async function seedJoinRows(
  args: {
    parentStatus?: "waiting" | "runnable";
    childStatus?: "running" | "completed";
  } = {},
): Promise<SeedJoinRowsResult> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  const parentRunId = `run_parent_${randomUUID().slice(0, 12)}`;
  const childRunId = `run_child_${randomUUID().slice(0, 12)}`;
  createdUserIds.push(userId);
  createdRunIds.push(parentRunId, childRunId);

  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  await db()
    .insert(agentRuns)
    .values([
      {
        id: parentRunId,
        userId,
        workflowSlug: "chat",
        currentStep: "chat-turn",
        status: args.parentStatus ?? "waiting",
        attempt: 1,
        state: {},
        wakeCondition: { kind: "signal", name: subAgentDoneSignalName(childRunId) },
        lastCheckpointAt: new Date(),
        metadata: {},
      },
      {
        id: childRunId,
        userId,
        workflowSlug: SUB_AGENT_WORKFLOW_SLUG,
        currentStep: "run",
        status: args.childStatus ?? "completed",
        attempt: 1,
        state: {},
        lastCheckpointAt: new Date(),
        metadata: {
          subAgent: {
            kind: "sub_agent",
            parentRunId,
            subId: "test_child",
            parentToolCallId: "call_test",
          },
        },
      },
    ]);

  return { userId, parentRunId, childRunId };
}

async function parentRunState(runId: string): Promise<{
  status: string | undefined;
  wakeCondition: unknown;
}> {
  const rows = await db()
    .select({ status: agentRuns.status, wakeCondition: agentRuns.wakeCondition })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return { status: rows[0]?.status, wakeCondition: rows[0]?.wakeCondition };
}

async function waitForParentRunnable(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await parentRunState(runId);
    if (row.status === "runnable" && row.wakeCondition === null) return;
    await sleep(50);
  }
  const row = await parentRunState(runId);
  assert.fail(`parent ${runId} was not woken; status=${row.status}`);
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

async function assertAgentRunQueued(runId: string): Promise<void> {
  const runIds = await queuedAgentRunIds();
  assert.equal(runIds.has(runId), true, `expected agent queue to contain run ${runId}`);
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

describe("sub-agent join wake liveness (DB/Redis-backed)", { skip: SKIP }, () => {
  before(async () => {
    seedServerEnvForQueueTests();
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  afterEach(async () => {
    await stopSubAgentJoinWakeWorker();
    await removeQueuedAgentRuns();
    for (const runId of createdRunIds) {
      const job = await getSubAgentJoinWakeQueue().getJob(subAgentJoinWakeJobId(runId));
      await job?.remove();
    }
  });

  after(async () => {
    await stopSubAgentJoinWakeWorker();
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeAgentQueue();
    await closeSubAgentJoinWakeQueue();
    await closeRedis();
    await closeConnections();
  });

  test("dead-man worker wakes and enqueues a parent stranded on a child signal", async () => {
    const { parentRunId, childRunId } = await seedJoinRows();
    await startSubAgentJoinWakeWorker();

    const scheduled = await scheduleSubAgentJoinWakeJob({
      childRunId,
      parentRunId,
      delayMs: 0,
    });

    assert.equal(scheduled, "scheduled");
    await waitForParentRunnable(parentRunId);
    await assertAgentRunQueued(parentRunId);
  });

  test("cancelling a child wakes and enqueues its waiting parent immediately", async () => {
    const { parentRunId, childRunId } = await seedJoinRows({ childStatus: "running" });

    const outcome = await cancelRun({ runId: childRunId, reason: "test cancellation" });

    assert.equal(outcome, "cancelled");
    await waitForParentRunnable(parentRunId);
    await assertAgentRunQueued(parentRunId);
  });
});
