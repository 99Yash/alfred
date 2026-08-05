import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { getStringPath, isTerminalStatus, TERMINAL_RUN_STATUSES } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, eventsOutbox, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";

import { commitStepSuccess, markRunFailed, runOnce } from "../../src/modules/agent/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import type { StepResult, Workflow } from "../../src/modules/agent/types";

/**
 * DB-backed test that PINS the server precondition item 49's client fix rests on
 * (item 56, follows ADR-0073:23): once the executor's run-update guard commits a
 * terminal `RUN_STATUS_KIND` status for a NON-CHAT run, that run has also
 * published at least one terminal-phase `agent.run` frame.
 *
 * If a close path ever set a terminal run status without publishing a terminal
 * `agent.run` frame, the client's replay barrier for that run would never
 * release — the exact leak item 49 closed on the client, relocated to the
 * server. This locks the pairing so a future terminal branch that forgets the
 * publish is caught, not re-verified by reading every close path.
 *
 * The four guard-committed terminal branches (`executor.ts`): `done`→`completed`,
 * `blocked`→`blocked`, an in-step throw→`failed` (`commitStepFailure`), and the
 * resolve-failure path→`failed` (`markRunFailed`). The last one paired only after
 * item 59 (PR #656); before it, that branch committed `failed` with no frame —
 * exactly the shape the load-bearing negative case pins below.
 *
 * The coupling is only observable at the persisted-row level: the guard writes
 * the status, and the `agent.run` publish is a SEPARATE `publishEvent` in the
 * same tx AFTER the guard, so a wrapper on the guard alone cannot see it. The
 * test drives each branch end-to-end and reads the two persisted effects —
 * `agent_runs.status` and any `events_outbox` `agent.run` row — matching the
 * established pattern in `commit-cancel-race.test.ts`.
 *
 * Terminality on both sides is derived from `RUN_STATUS_KIND` (via
 * `isTerminalStatus` / `TERMINAL_RUN_STATUSES`), never a hand-listed set, so a
 * new terminal status is covered without editing this file.
 *
 * The two terminal writers that BYPASS the guard — cancel (`service.ts`) and the
 * lease backstop (`executor.ts`) — self-pair and are out of this test's scope.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-terminal-pairing-";
const createdUserIds: string[] = [];
const STEP = "chat-turn";
const THROW_SLUG = "__test-terminal-pairing-throw";

/** A non-chat workflow whose step throws, driving the in-step `failed` branch. */
const throwWorkflow: Workflow<Record<string, never>> = {
  slug: THROW_SLUG,
  name: "terminal pairing throw test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: STEP,
  closure: { kind: "none" },
  steps: {
    [STEP]: {
      id: STEP,
      run: async (): Promise<StepResult<Record<string, never>>> => {
        throw new Error("step exploded for the terminal-pairing test");
      },
    },
  },
};

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });
  return userId;
}

async function seedRun(args: {
  workflowSlug: string;
  status: "runnable" | "running" | "failed";
  attempt: number;
}): Promise<{ userId: string; runId: string }> {
  const userId = await seedUser();
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: args.workflowSlug,
    currentStep: STEP,
    status: args.status,
    attempt: args.attempt,
    lastCheckpointAt: new Date(),
  });
  return { userId, runId };
}

function runRow(userId: string, runId: string, workflowSlug: string, attempt: number) {
  return {
    id: runId,
    userId,
    workflowSlug,
    status: "running" as const,
    state: {},
    transcript: [],
    currentStep: STEP,
    attempt,
    metadata: {},
  };
}

async function readStatus(runId: string) {
  const rows = await db()
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return rows[0]?.status;
}

/** Terminal `agent.run` phases, derived from `RUN_STATUS_KIND` — not hand-listed. */
const TERMINAL_PHASES: readonly string[] = TERMINAL_RUN_STATUSES;

/**
 * The pairing assertion. Reads `agent_runs.status`; when the run is terminal per
 * `isTerminalStatus`, it requires at least one `events_outbox` `agent.run` row
 * for that run whose `payload.phase` is terminal per the SAME `RUN_STATUS_KIND`
 * source — and FAILS when the status is terminal but no such frame exists.
 * Test-local: no production seam is added (this item is ledger-neutral).
 */
async function assertTerminalRunEmitsTerminalFrame(userId: string, runId: string): Promise<void> {
  const status = await readStatus(runId);
  assert.ok(status, `run ${runId} exists`);
  if (!isTerminalStatus(status)) return;

  const rows = await db()
    .select({ payload: eventsOutbox.payload })
    .from(eventsOutbox)
    .where(and(eq(eventsOutbox.userId, userId), eq(eventsOutbox.kind, "agent.run")));
  const hasTerminalFrame = rows.some((r) => {
    const phase = getStringPath(r.payload, "phase");
    return (
      getStringPath(r.payload, "runId") === runId &&
      phase !== undefined &&
      TERMINAL_PHASES.includes(phase)
    );
  });

  assert.ok(
    hasTerminalFrame,
    `run ${runId} committed terminal status "${status}" but published no terminal agent.run frame`,
  );
}

describe("terminal run ⟹ terminal agent.run frame (item 56, DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
    if (!getWorkflow(THROW_SLUG)) registerWorkflow(throwWorkflow);
  });
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    await closeConnections();
  });

  test("done→completed pairs a terminal agent.run frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "running",
      attempt: 1,
    });

    const outcome = await commitStepSuccess(
      runRow(userId, runId, THROW_SLUG, 1),
      STEP,
      1,
      { kind: "done", state: {}, output: { ok: true } },
      [],
      [],
    );

    assert.equal(outcome.kind, "completed");
    assert.equal(await readStatus(runId), "completed");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  test("blocked→blocked pairs a terminal agent.run frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "running",
      attempt: 1,
    });

    const outcome = await commitStepSuccess(
      runRow(userId, runId, THROW_SLUG, 1),
      STEP,
      1,
      { kind: "blocked", state: {}, output: { reason: "action required" } },
      [],
      [],
    );

    assert.equal(outcome.kind, "blocked");
    assert.equal(await readStatus(runId), "blocked");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  test("an in-step throw→failed pairs a terminal agent.run frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "runnable",
      attempt: 0,
    });

    const outcome = await runOnce(runId);

    assert.equal(outcome.kind, "failed");
    assert.equal(await readStatus(runId), "failed");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  test("the resolve-failure path (markRunFailed)→failed pairs a terminal agent.run frame", async () => {
    // The branch item 59 (PR #656) turned green: before it, `markRunFailed`
    // committed `failed` inside a tx with NO `agent.run` publish.
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "running",
      attempt: 1,
    });

    const cause = await markRunFailed(
      runRow(userId, runId, THROW_SLUG, 1),
      STEP,
      1,
      "no step registered; deploy mismatch?",
    );

    assert.equal(cause, null, "the failure landed on a run this worker owns");
    assert.equal(await readStatus(runId), "failed");
    await assertTerminalRunEmitsTerminalFrame(userId, runId);
  });

  // The helper is load-bearing, not vacuous: a terminal status with no terminal
  // frame — the exact pre-item-59 `markRunFailed` shape — must make it FAIL.
  test("the helper fails a terminal run that published no terminal frame", async () => {
    const { userId, runId } = await seedRun({
      workflowSlug: THROW_SLUG,
      status: "failed",
      attempt: 1,
    });

    await assert.rejects(
      assertTerminalRunEmitsTerminalFrame(userId, runId),
      /published no terminal agent\.run frame/,
      "a terminal status with no paired frame is the leak this test pins",
    );
  });
});
