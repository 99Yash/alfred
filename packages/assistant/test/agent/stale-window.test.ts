import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, agentSteps, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { leaseRun } from "@alfred/assistant/execution/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerRecipe,
} from "@alfred/assistant/execution/registry";
import {
  collectResumableRunIds,
  findResumableRunIds,
  minStaleAfterMs,
  type ResumeSweepCandidate,
  resolveStaleAfterMs,
  STALE_RUN_LEASE_MS,
} from "@alfred/assistant/execution/service";
import type { StepResult, Workflow } from "@alfred/assistant/execution";
import { userAuthoredBriefWorkflow } from "@alfred/assistant/execution/workflows/user-authored-brief";
import { dbBackedSkip } from "../support/db-backed";

/**
 * Per-step `staleAfterMs` (ADR-0070 §1.4). A reclaim bumps `attempt`, which is in
 * the LLM idempotency key, so a wrong reclaim pays for a duplicate model call.
 * `leaseRun` and the `findResumableRunIds` sweep must agree on the window.
 */
const SKIP = dbBackedSkip("database");

const SLUG = "__test-stale-window";

const ID_PREFIX = "test-stale-window-";

// No production step is narrower than the 60s default; narrow tests the `minStaleAfterMs` floor.
const WIDE_MS = 5 * 60_000;

const NARROW_MS = 30_000;

const GIANT_MS = 60 * 60_000;

const noopStep = (id: string, staleAfterMs?: number): Workflow<unknown>["steps"][string] => ({
  id,
  ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  run: async (): Promise<StepResult<unknown>> => ({ kind: "done", state: {}, output: {} }),
});

const windowWorkflow: Workflow<unknown> = {
  slug: SLUG,
  name: "stale-window test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: "wide-step",
  closure: { kind: "none" },
  steps: {
    "wide-step": noopStep("wide-step", WIDE_MS),
    "quick-step": noopStep("quick-step"),
    "fast-step": noopStep("fast-step", NARROW_MS),
    "giant-step": noopStep("giant-step", GIANT_MS),
  },
};

const ago = (ms: number): Date => new Date(Date.now() - ms);

describe("per-step stale-lease resolution (pure)", () => {
  before(() => {
    if (!getWorkflow(SLUG)) registerRecipe(windowWorkflow);
  });
  after(() => {
    _resetRegistryForTests();
  });

  test("resolveStaleAfterMs returns the step's declared window when set", () => {
    assert.equal(resolveStaleAfterMs(SLUG, "wide-step"), WIDE_MS);
    assert.equal(resolveStaleAfterMs(SLUG, "fast-step"), NARROW_MS);
  });

  test("resolveStaleAfterMs falls back to the default for an undeclared step", () => {
    assert.equal(resolveStaleAfterMs(SLUG, "quick-step"), STALE_RUN_LEASE_MS);
  });

  test("resolveStaleAfterMs falls back to the default for an unknown slug or step", () => {
    assert.equal(resolveStaleAfterMs("no-such-workflow", "wide-step"), STALE_RUN_LEASE_MS);
    assert.equal(resolveStaleAfterMs(SLUG, "no-such-step"), STALE_RUN_LEASE_MS);
  });

  test("resolveStaleAfterMs applies shared user-authored step windows to authored slugs", () => {
    // Authored rows keep their own slug but run the shared `userAuthoredBriefWorkflow` body.
    assert.equal(
      resolveStaleAfterMs("my-authored-workflow", "boss-turn"),
      userAuthoredBriefWorkflow.steps["boss-turn"]?.staleAfterMs,
    );
  });

  test("the sweep paginates past a page filled by per-step refinement", async () => {
    // A live row refined out of a full page must not hide a stale row behind it.
    // The page reader is injected: the real sweep reads every user's rows, which raced in CI.
    const candidate = (id: string, currentStep: string, staleMs: number): ResumeSweepCandidate => ({
      id,
      workflowSlug: SLUG,
      currentStep,
      status: "running",
      staleMs,
    });

    const pages: ResumeSweepCandidate[][] = [
      [candidate("run_giant_fresh", "giant-step", 90_000)],
      [candidate("run_quick_stale", "quick-step", 80_000)],
    ];

    const reads: { limit: number; offset: number }[] = [];

    const resumable = await collectResumableRunIds(1, async (page) => {
      reads.push(page);

      return pages[page.offset] ?? [];
    });

    assert.deepEqual(resumable, ["run_quick_stale"]);
    assert.deepEqual(
      reads,
      [
        { limit: 1, offset: 0 },
        { limit: 1, offset: 1 },
      ],
      "the refined-out row advances the offset instead of ending the sweep",
    );
  });

  test("minStaleAfterMs is the smallest declared window (the SQL sweep floor)", () => {
    // The sweep selects at the floor, so every step's window must be >= the floor.
    assert.equal(minStaleAfterMs(), NARROW_MS);
    assert.ok(minStaleAfterMs() <= STALE_RUN_LEASE_MS, "floor is never above the default");

    for (const step of Object.values(windowWorkflow.steps)) {
      assert.ok(
        minStaleAfterMs() <= resolveStaleAfterMs(SLUG, step.id),
        `floor must be <= every step's window (${step.id})`,
      );
    }
  });
});

const createdUserIds: string[] = [];

async function seedRunningRun(step: string, checkpointAt: Date, attempt = 3): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: SLUG,
    currentStep: step,
    status: "running",
    attempt,
    lastCheckpointAt: checkpointAt,
  });
  // The step row a live worker would hold. `leaseRun` marks it failed on reclaim.
  await db().insert(agentSteps).values({ runId, stepId: step, attempt, status: "running" });

  return runId;
}

async function runRow(runId: string): Promise<{ status: string; attempt: number } | undefined> {
  const rows = await db()
    .select({ status: agentRuns.status, attempt: agentRuns.attempt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));

  return rows[0];
}

describe("per-step stale-lease window honored by lease + sweep (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));

    if (!getWorkflow(SLUG)) registerRecipe(windowWorkflow);
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    _resetRegistryForTests();
    await closeConnections();
  });

  test("leaseRun does NOT reclaim a wide-window step within its window", async () => {
    // Past the 60s default, inside the 5min window.
    const runId = await seedRunningRun("wide-step", ago(90_000));
    const leased = await leaseRun(runId);
    assert.equal(leased.kind, "none", "a live wide-window turn must not be reclaimed at 60s");
    const row = await runRow(runId);
    assert.equal(row?.status, "running", "the run stays owned by the presumed-live worker");
    assert.equal(row?.attempt, 3, "attempt is NOT bumped — no reclaim, no duplicate model call");
  });

  test("leaseRun reclaims a wide-window step once its window elapses", async () => {
    const runId = await seedRunningRun("wide-step", ago(WIDE_MS + 60_000));
    const leased = await leaseRun(runId);
    assert.equal(leased.kind, "leased", "past the wide window, a dead worker is reclaimed");
    assert.equal(leased.kind === "leased" ? leased.attempt : undefined, 4, "reclaim bumps attempt");
  });

  test("leaseRun keeps the 60s default for a step that declares no window", async () => {
    const reclaimable = await seedRunningRun("quick-step", ago(90_000));
    assert.equal((await leaseRun(reclaimable)).kind, "leased", "default step reclaims past 60s");

    const fresh = await seedRunningRun("quick-step", ago(45_000));
    assert.equal((await leaseRun(fresh)).kind, "none", "default step is fresh under 60s");
  });

  test("leaseRun reclaims a narrow-window step sooner than the default would", async () => {
    // Fresh for a default step, but past this step's 30s window.
    const runId = await seedRunningRun("fast-step", ago(45_000));
    assert.equal((await leaseRun(runId)).kind, "leased", "narrow window reclaims before 60s");
  });

  test("findResumableRunIds refines per-step after selecting at the floor", async () => {
    const included: string[] = [];
    const excluded: string[] = [];

    const wideFresh = await seedRunningRun("wide-step", ago(90_000)); // 90s < 5min
    excluded.push(wideFresh);
    const wideStale = await seedRunningRun("wide-step", ago(WIDE_MS + 60_000)); // > 5min
    included.push(wideStale);
    const quickStale = await seedRunningRun("quick-step", ago(90_000)); // 90s > 60s default
    included.push(quickStale);
    const fastStale = await seedRunningRun("fast-step", ago(45_000)); // 45s > 30s window
    included.push(fastStale);
    const fastFresh = await seedRunningRun("fast-step", ago(20_000)); // 20s < 30s (below floor)
    excluded.push(fastFresh);

    const resumable = new Set(await findResumableRunIds({ limit: 1000 }));

    for (const id of included) {
      assert.ok(resumable.has(id), `genuinely-stale run ${id} must be swept in`);
    }

    for (const id of excluded) {
      assert.ok(!resumable.has(id), `live run ${id} must be refined out, not re-enqueued`);
    }
  });
});
