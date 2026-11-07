import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { DAILY_BRIEFING_WORKFLOW_SLUG, getStringPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import { agentRuns, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import type { StepResult, Workflow } from "@alfred/assistant/execution";
import { agentQueue } from "@alfred/assistant/execution/queue";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { enqueueBriefingRun } from "../../src/briefings/run";
import { dbBackedSkip } from "../support/db-backed";

// SM-04 in docs/reference/state-machines.md: a second manual "Run briefing" for the same day and
// slot must start a new run after the first one failed, not hand back the terminal run.

const SKIP = dbBackedSkip("database+redis");

const ID_PREFIX = "test-briefing-manual-retry-";

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

// Stands in for the real briefing workflow; its step never runs.
const stubBriefingRecipe: Workflow<unknown> = {
  slug: DAILY_BRIEFING_WORKFLOW_SLUG,
  name: "briefing manual retry stub",
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

const createdUserIds: string[] = [];

const createdRunIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Briefing Retry", email: `${userId}@example.test` });

  return userId;
}

describe("manual briefing retry starts a new run (DB/Redis-backed)", { skip: SKIP }, () => {
  before(async () => {
    for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
      process.env[key] ??= value;
    }

    if (!getWorkflow(DAILY_BRIEFING_WORKFLOW_SLUG)) registerRecipe(stubBriefingRecipe);
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

  test("a retry after a failed manual run gets a fresh pending run", async () => {
    const userId = await seedUser();

    const request = {
      userId,
      slot: "morning" as const,
      briefingDate: "2026-11-07",
      reason: "manual" as const,
    };

    const first = await enqueueBriefingRun(request);
    createdRunIds.push(first.runId);

    await db()
      .update(agentRuns)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(agentRuns.id, first.runId));

    const second = await enqueueBriefingRun(request);
    createdRunIds.push(second.runId);

    assert.notEqual(second.runId, first.runId);

    const [row] = await db()
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, second.runId));

    assert.equal(row?.status, "pending");
  });
});
