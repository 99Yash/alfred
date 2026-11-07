import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  getStringPath,
  parseIanaTimezone,
  type BriefingStatus,
} from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import { agentRuns, briefings, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { runOnce } from "@alfred/assistant/execution/executor";
import { agentQueue } from "@alfred/assistant/execution/queue";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import { cancelRun } from "@alfred/assistant/execution/service";
import { dailyBriefingWorkflow } from "../../src/briefings/daily-briefing";
import { beginBriefing } from "../../src/briefings/store";
import type { DailyBriefingOperationState } from "../../src/briefings/workflow-operations";
import { dbBackedSkip } from "../support/db-backed";

// SM-11 in docs/reference/state-machines.md: a briefing run that ends failed or cancelled outside
// the step's own `markBriefingFailed` must not leave its `briefings` row in a live status, because
// that row blocks every retry for the day.

const SKIP = dbBackedSkip("database+redis");

const ID_PREFIX = "test-briefing-run-closure-";

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

const BRIEFING_DATE = "2026-11-07";

const TIMEZONE = parseIanaTimezone("UTC");

const createdUserIds: string[] = [];

const createdRunIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Briefing Closure", email: `${userId}@example.test` });

  return userId;
}

async function seedBriefing(args: {
  userId: string;
  status: BriefingStatus;
  agentRunId: string;
}): Promise<string> {
  const [row] = await db()
    .insert(briefings)
    .values({
      userId: args.userId,
      briefingDate: BRIEFING_DATE,
      slot: "morning",
      timezone: TIMEZONE,
      status: args.status,
      agentRunId: args.agentRunId,
    })
    .returning({ id: briefings.id });

  assert.ok(row);

  return row.id;
}

/**
 * A run parked at compose. Its state passes `stateSchema` but has no `untilIngestedAt`, so the
 * compose step throws before it reaches its own `markBriefingFailed`.
 */
async function seedComposeRun(args: {
  userId: string;
  runId: string;
  briefingId: string;
}): Promise<void> {
  const state: DailyBriefingOperationState = {
    slot: "morning",
    reason: "manual",
    dryRun: false,
    briefingDate: BRIEFING_DATE,
    timezone: TIMEZONE,
    briefingId: args.briefingId,
    closedLoops: [],
    loops: [],
  };

  createdRunIds.push(args.runId);
  await db().insert(agentRuns).values({
    id: args.runId,
    userId: args.userId,
    workflowSlug: DAILY_BRIEFING_WORKFLOW_SLUG,
    currentStep: "compose",
    status: "pending",
    attempt: 0,
    state,
  });
}

async function briefingStatus(briefingId: string): Promise<BriefingStatus | undefined> {
  const [row] = await db()
    .select({ status: briefings.status })
    .from(briefings)
    .where(eq(briefings.id, briefingId));

  return row?.status;
}

function newRunId(): string {
  return `run_${randomUUID().slice(0, 12)}`;
}

describe(
  "a briefing run's terminal closure fails its row (DB/Redis-backed)",
  { skip: SKIP },
  () => {
    before(async () => {
      for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
        process.env[key] ??= value;
      }

      if (!getWorkflow(DAILY_BRIEFING_WORKFLOW_SLUG)) registerRecipe(dailyBriefingWorkflow);
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

    test("a step that throws outside its try leaves the row failed", async () => {
      const userId = await seedUser();
      const runId = newRunId();
      const briefingId = await seedBriefing({ userId, status: "gathering", agentRunId: runId });
      await seedComposeRun({ userId, runId, briefingId });

      const outcome = await runOnce(runId);

      assert.equal(outcome.kind, "failed");
      assert.equal(await briefingStatus(briefingId), "failed");
    });

    test("a cancelled run leaves the row failed", async () => {
      const userId = await seedUser();
      const runId = newRunId();
      const briefingId = await seedBriefing({ userId, status: "composing", agentRunId: runId });
      await seedComposeRun({ userId, runId, briefingId });

      assert.equal(await cancelRun({ runId, reason: "user_stopped" }), "cancelled");
      assert.equal(await briefingStatus(briefingId), "failed");
    });

    test("a run does not fail a row that another run owns", async () => {
      const userId = await seedUser();
      const runId = newRunId();

      const briefingId = await seedBriefing({
        userId,
        status: "gathering",
        agentRunId: newRunId(),
      });

      await seedComposeRun({ userId, runId, briefingId });

      const outcome = await runOnce(runId);

      assert.equal(outcome.kind, "failed");
      assert.equal(await briefingStatus(briefingId), "gathering");
    });

    test("a run that resumes a live row takes it over", async () => {
      const userId = await seedUser();
      const runId = newRunId();

      const briefingId = await seedBriefing({
        userId,
        status: "gathering",
        agentRunId: newRunId(),
      });

      const begun = await beginBriefing({
        userId,
        briefingDate: BRIEFING_DATE,
        slot: "morning",
        timezone: TIMEZONE,
        agentRunId: runId,
      });

      assert.equal(begun.action, "resume");
      assert.equal(begun.row.id, briefingId);
      assert.equal(begun.row.agentRunId, runId);
    });
  },
);
