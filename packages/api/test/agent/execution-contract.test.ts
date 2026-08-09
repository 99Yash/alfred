import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getStringPath } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, agentSteps, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { closeAgentQueue, getAgentQueue } from "../../src/modules/agent/queue";
import { leaseRun, runOnce } from "../../src/modules/agent/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "../../src/modules/agent/registry";
import { cancelRun, getRun, signalRun, startRun } from "../../src/modules/agent/service";
import type {
  StepContext,
  StepResult,
  TerminalOutcome,
  Workflow,
} from "../../src/modules/agent/types";

/**
 * Generic execution contract for the durable-execution module (campaign item
 * 06; Phase 3 "Done when"). ONE product-free recipe family (`__exec-contract-*`
 * — `__` marks it internal, excluded from catalogs) driven through the six
 * lifecycle transitions the plan names: start, retry, signal, cancellation,
 * resume, and terminal closure. It consumes the public service surface unchanged
 * (`registerRecipe`, `startRun`, `signalRun`, `cancelRun`, `getRun`) and drives
 * attempts with `runOnce`/`leaseRun` directly — never the worker — so no product
 * recipe (`chat`, `triage`, …) is touched anywhere in this file.
 *
 * Invariant pinned here: given a product-free recipe registered via
 * `registerRecipe`, after any allowed sequence of `startRun` -> `runOnce`
 * attempts (including a deferred retry) -> `signalRun` -> `cancelRun` ->
 * stale-lease reclaim -> terminal commit, `getRun` reflects exactly the terminal
 * `status`/`output` the recipe's `StepResult`s imply, a retry bumps `attempt`
 * without re-running an already-committed `(runId, stepId, attempt)`, and no step
 * body executes once the run is terminal.
 *
 * Opt-in: runs only when `DATABASE_URL` and `REDIS_URL` point at reachable test
 * services (`startRun` enqueues, so Redis is required). Seeds throwaway
 * `test-exec-contract-*` users and cascades them away on teardown; the enqueued
 * jobs are removed directly because no worker runs here. A skip is NOT a pass.
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

const ID_PREFIX = "test-exec-contract-";
const SIGNAL_NAME = "exec-contract-go";
const STEP = "work";

type ContractState = Record<string, never>;

const START_SLUG = "__exec-contract-start";
const RETRY_SLUG = "__exec-contract-retry";
const SIGNAL_SLUG = "__exec-contract-signal";
const CANCEL_SLUG = "__exec-contract-cancel";
const COMPLETE_SLUG = "__exec-contract-complete";
const FAIL_SLUG = "__exec-contract-fail";
const RESUME_SLUG = "__exec-contract-resume";

const createdUserIds: string[] = [];
const createdRunIds: string[] = [];

/** Every step-body entry, in order — proves what ran (and at which attempt). */
const bodyRuns: { runId: string; attempt: number }[] = [];
/** Every client-closure invocation — records WHICH branch fired, and its reason. */
const terminalCalls: { runId: string; outcome: TerminalOutcome["outcome"]; reason: string }[] = [];

function recordBody(ctx: StepContext<ContractState>): void {
  bodyRuns.push({ runId: ctx.runId, attempt: ctx.attempt });
}

function attemptsFor(runId: string): number[] {
  return bodyRuns.filter((entry) => entry.runId === runId).map((entry) => entry.attempt);
}

/** A client closure that records which terminal branch drove it (never resurrects the run). */
const recordingClosure: Extract<Workflow<ContractState>["closure"], { kind: "client" }> = {
  kind: "client",
  async onTerminal(ctx) {
    terminalCalls.push({
      runId: ctx.runId,
      outcome: ctx.outcome,
      reason: ctx.outcome === "failed" ? ctx.error : ctx.reason,
    });
  },
};

function contractRecipe(
  slug: string,
  run: (ctx: StepContext<ContractState>) => Promise<StepResult<ContractState>>,
  closure: Workflow<ContractState>["closure"] = { kind: "none" },
): Workflow<ContractState> {
  return {
    slug,
    name: `execution contract ${slug}`,
    trigger: { kind: "manual" },
    initialState: () => ({}),
    initialStep: STEP,
    closure,
    steps: { [STEP]: { id: STEP, run } },
  };
}

// start: never leaves `pending` here — the test asserts persist, not execution.
const startRecipe = contractRecipe(START_SLUG, async (ctx) => {
  recordBody(ctx);
  return { kind: "done", state: {}, output: {} };
});

// retry: attempt 0 defers to a retry instant already in the past; the re-lease
// runs the SAME step at the bumped attempt 1 and completes. Deferring is the
// executor's bounded-retry seam — a THROW is terminal, not a retry.
const retryRecipe = contractRecipe(RETRY_SLUG, async (ctx) => {
  recordBody(ctx);
  if (ctx.attempt === 0) {
    return { kind: "defer", state: {}, retryAt: new Date(Date.now() - 1_000) };
  }
  return { kind: "done", state: {}, output: { retriedAt: ctx.attempt } };
});

// signal: attempt 0 parks on a signal wake; after `signalRun` matches, the
// re-lease runs the same step at the bumped attempt 1 and completes.
const signalRecipe = contractRecipe(SIGNAL_SLUG, async (ctx) => {
  recordBody(ctx);
  if (ctx.attempt === 0) {
    return { kind: "interrupt", state: {}, wake: { kind: "signal", name: SIGNAL_NAME } };
  }
  return { kind: "done", state: {}, output: { woken: true } };
});

// cancel: the body must never run — the run is cancelled while still pending.
const cancelRecipe = contractRecipe(
  CANCEL_SLUG,
  async (ctx) => {
    recordBody(ctx);
    return { kind: "done", state: {}, output: {} };
  },
  recordingClosure,
);

// terminal closure (success): completes in one attempt; client closure must NOT
// fire (it fires only on failed/cancelled).
const completeRecipe = contractRecipe(
  COMPLETE_SLUG,
  async (ctx) => {
    recordBody(ctx);
    return { kind: "done", state: {}, output: { done: true } };
  },
  recordingClosure,
);

// terminal closure (failure): the body throws → terminal `failed`; client
// closure fires with `outcome: "failed"`.
const failRecipe = contractRecipe(
  FAIL_SLUG,
  async (ctx) => {
    recordBody(ctx);
    throw new Error("exec-contract intentional failure");
  },
  recordingClosure,
);

// resume: body is never invoked — leaseRun only inspects the step's declared
// (default) stale window when reclaiming a presumed-dead worker.
const resumeRecipe = contractRecipe(RESUME_SLUG, async (ctx) => {
  recordBody(ctx);
  return { kind: "done", state: {}, output: {} };
});

const RECIPES = [
  startRecipe,
  retryRecipe,
  signalRecipe,
  cancelRecipe,
  completeRecipe,
  failRecipe,
  resumeRecipe,
];

function seedServerEnv(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Exec Contract", email: `${userId}@example.test` });
  return userId;
}

/** Start a run through the public entry point and track it for teardown. */
async function startContractRun(workflowSlug: string): Promise<{ userId: string; runId: string }> {
  const userId = await seedUser();
  const { runId, created } = await startRun({
    userId,
    workflowSlug,
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });
  assert.equal(created, true, "startRun persists a fresh run row");
  createdRunIds.push(runId);
  return { userId, runId };
}

async function removeQueuedContractRuns(): Promise<void> {
  const queue = getAgentQueue();
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500);
  await Promise.all(
    jobs.map(async (job) => {
      const runId = getStringPath(job.data, "runId");
      if (runId && createdRunIds.includes(runId)) await job.remove();
    }),
  );
}

/** The terminal `agent.run`/`failed` frames this run emitted (phase === "failed"). */
async function failedRunFrames(userId: string, runId: string): Promise<unknown[]> {
  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "agent.run")));
  return rows
    .map((row) => row.payload)
    .filter(
      (payload) =>
        getStringPath(payload, "runId") === runId && getStringPath(payload, "phase") === "failed",
    );
}

describe("generic execution contract (DB/Redis-backed)", { skip: SKIP }, () => {
  before(async () => {
    seedServerEnv();
    for (const recipe of RECIPES) {
      if (!getWorkflow(recipe.slug)) registerRecipe(recipe);
    }
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  beforeEach(() => {
    bodyRuns.length = 0;
    terminalCalls.length = 0;
  });

  afterEach(async () => {
    await removeQueuedContractRuns();
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

  test("start — startRun persists a pending run at its initial step", async () => {
    const { userId, runId } = await startContractRun(START_SLUG);

    const run = await getRun(runId, userId);
    assert.ok(run, "getRun returns the persisted run");
    assert.equal(run.status, "pending", "a fresh run is pending, not yet executed");
    assert.equal(run.currentStep, STEP, "it sits at the recipe's initial step");
    assert.equal(run.attempt, 0, "a fresh run starts at attempt 0");
    assert.deepEqual(attemptsFor(runId), [], "no step body ran — start only persists");
  });

  test("retry — a deferred attempt bumps `attempt` and re-runs the same step to completion", async () => {
    const { userId, runId } = await startContractRun(RETRY_SLUG);

    const first = await runOnce(runId);
    assert.equal(first.kind, "deferred", "attempt 0 parks the run on a bounded retry");
    const parked = await getRun(runId, userId);
    assert.equal(parked?.status, "deferred");
    assert.equal(parked?.attempt, 1, "the defer commit bumped the attempt");

    const second = await runOnce(runId);
    assert.equal(second.kind, "completed", "the retry attempt runs the same step and completes");

    const done = await getRun(runId, userId);
    assert.equal(done?.status, "completed");
    assert.equal(done?.attempt, 1);
    assert.deepEqual(done?.output, { retriedAt: 1 }, "the terminal output is the retry's result");
    assert.deepEqual(
      attemptsFor(runId),
      [0, 1],
      "the body ran once per attempt — the committed attempt 0 was never re-run",
    );
  });

  test("signal — a parked run resumes only when signalRun matches its wake", async () => {
    const { userId, runId } = await startContractRun(SIGNAL_SLUG);

    const parkOutcome = await runOnce(runId);
    assert.equal(parkOutcome.kind, "interrupted", "attempt 0 parks on a signal wake");

    const waiting = await getRun(runId, userId);
    assert.equal(waiting?.status, "waiting");
    assert.deepEqual(
      waiting?.wakeCondition,
      { kind: "signal", name: SIGNAL_NAME },
      "the wake condition is persisted for the signal to match",
    );

    const wrong = await signalRun({ runId, match: { kind: "signal", name: "not-the-signal" } });
    assert.equal(wrong, false, "a mismatched signal does not wake the run");
    assert.equal((await getRun(runId, userId))?.status, "waiting", "still parked after a mismatch");

    const woken = await signalRun({ runId, match: { kind: "signal", name: SIGNAL_NAME } });
    assert.equal(woken, true, "the matching signal wakes the run");
    const runnable = await getRun(runId, userId);
    assert.equal(runnable?.status, "runnable");
    assert.equal(runnable?.wakeCondition, null, "the wake condition is cleared on wake");

    const resumed = await runOnce(runId);
    assert.equal(resumed.kind, "completed", "the resumed attempt completes the run");
    assert.equal((await getRun(runId, userId))?.status, "completed");
    assert.deepEqual(attemptsFor(runId), [0, 1], "parked at attempt 0, resumed at attempt 1");
  });

  test("cancellation — cancelRun makes the run terminal and no body ever runs", async () => {
    const { userId, runId } = await startContractRun(CANCEL_SLUG);

    const outcome = await cancelRun({ runId, reason: "exec-contract cancel" });
    assert.equal(outcome, "cancelled");

    const run = await getRun(runId, userId);
    assert.equal(run?.status, "cancelled", "the run is terminal");
    assert.equal(run?.wakeCondition, null, "the cancel nulls the wake condition");

    // Forbidden effect: a later lease attempt must not run the step body.
    const late = await runOnce(runId);
    assert.equal(late.kind, "skipped", "a terminal run is never leased for another attempt");
    assert.deepEqual(attemptsFor(runId), [], "the step body never executed on a cancelled run");

    assert.deepEqual(
      terminalCalls,
      [{ runId, outcome: "cancelled", reason: "exec-contract cancel" }],
      "client closure fired exactly once, on the cancelled branch",
    );
    assert.deepEqual(
      await failedRunFrames(userId, runId),
      [],
      "no agent.run/failed frame leaked over a cancelled run",
    );
  });

  test("terminal closure (success) — a completed run persists its output and skips client closure", async () => {
    const { userId, runId } = await startContractRun(COMPLETE_SLUG);

    const outcome = await runOnce(runId);
    assert.equal(outcome.kind, "completed");

    const run = await getRun(runId, userId);
    assert.equal(run?.status, "completed");
    assert.deepEqual(run?.output, { done: true }, "the terminal output is persisted");
    assert.deepEqual(
      terminalCalls,
      [],
      "client closure fires only on failed/cancelled — a `done` completes inside the step body",
    );

    // Forbidden effect: a completed run is terminal; a later lease runs nothing.
    const late = await runOnce(runId);
    assert.equal(late.kind, "skipped");
    assert.deepEqual(attemptsFor(runId), [0], "the body ran exactly once, at attempt 0");
  });

  test("terminal closure (failure) — a thrown step fails the run and drives failure closure", async () => {
    const { userId, runId } = await startContractRun(FAIL_SLUG);

    const outcome = await runOnce(runId);
    assert.equal(outcome.kind, "failed", "a thrown step terminally fails the run");

    const run = await getRun(runId, userId);
    assert.equal(run?.status, "failed");
    assert.equal(
      getStringPath(run?.error, "message"),
      "exec-contract intentional failure",
      "the sanitized failure message is persisted",
    );
    assert.deepEqual(
      terminalCalls,
      [{ runId, outcome: "failed", reason: "exec-contract intentional failure" }],
      "client closure fired once, on the failed branch",
    );
    assert.equal(
      (await failedRunFrames(userId, runId)).length,
      1,
      "exactly one terminal agent.run/failed frame released the run",
    );

    // Forbidden effect: a failed run is terminal; a later lease runs nothing.
    const late = await runOnce(runId);
    assert.equal(late.kind, "skipped");
    assert.deepEqual(
      attemptsFor(runId),
      [0],
      "the body ran exactly once — the throw was not retried",
    );
  });

  test("resume — leaseRun reclaims a stale `running` row with a bumped attempt", async () => {
    // A presumed-dead worker: a `running` row whose heartbeat lapsed past the
    // default stale window, plus the orphan step row it left behind.
    const userId = await seedUser();
    const runId = `run_${randomUUID().slice(0, 12)}`;
    createdRunIds.push(runId);
    const staleCheckpoint = new Date(Date.now() - 5 * 60_000);
    await db().insert(agentRuns).values({
      id: runId,
      userId,
      workflowSlug: RESUME_SLUG,
      currentStep: STEP,
      status: "running",
      attempt: 3,
      lastCheckpointAt: staleCheckpoint,
    });
    await db().insert(agentSteps).values({ runId, stepId: STEP, attempt: 3, status: "running" });

    const leased = await leaseRun(runId);
    assert.equal(leased.kind, "leased", "the stale running row is reclaimed");
    assert.equal(
      leased.kind === "leased" ? leased.attempt : undefined,
      4,
      "the reclaim bumps the attempt so the next step row cannot collide",
    );

    const orphan = await db()
      .select({ status: agentSteps.status, reason: agentSteps.error })
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, runId), eq(agentSteps.attempt, 3)));
    assert.equal(orphan[0]?.status, "failed", "the orphan step row is marked failed for audit");
    assert.equal(
      getStringPath(orphan[0]?.reason, "reason"),
      "lease_reclaimed",
      "with the structured lease-reclaim marker",
    );
    assert.deepEqual(
      attemptsFor(runId),
      [],
      "leaseRun inspects the window; it does not run the body",
    );
  });
});
