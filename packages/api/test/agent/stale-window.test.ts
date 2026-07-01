import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, agentSteps, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { leaseRun } from "../../src/modules/agent/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import {
  findResumableRunIds,
  minStaleAfterMs,
  resolveStaleAfterMs,
  STALE_RUN_LEASE_MS,
} from "../../src/modules/agent/service";
import type { StepResult, Workflow } from "../../src/modules/agent/types";
import { userAuthoredBriefWorkflow } from "../../src/modules/agent/workflows/user-authored-brief";

/**
 * Tests for the per-step stale-lease window (ADR-0070 §1.4, Lever A). Lever A
 * lets a step declare a `staleAfterMs` wider (or narrower) than the 60s default
 * so a heartbeat blip can't reclaim a live, multi-minute model turn — which,
 * because the LLM idempotency key includes `attempt` (bumped on reclaim), would
 * be a duplicate full-price call. Two mechanisms consume the window and both
 * must agree:
 *   - `leaseRun` (under the row lock) — the authoritative reclaim gate.
 *   - `findResumableRunIds` (the sweep) — selects `running` candidates at the
 *     `minStaleAfterMs` floor in SQL, then refines each against its precise
 *     per-step window in JS so healthy long turns aren't re-enqueued every
 *     sweep only to be declined by `leaseRun`.
 *
 * The pure-resolver block always runs. The lease/sweep block is opt-in: it runs
 * only when `DATABASE_URL` points at a reachable migrated Postgres.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const SLUG = "__test-stale-window";
const ID_PREFIX = "test-stale-window-";

// Wide: a long non-streaming model turn (mirrors the sub-agent boss-turn's
// 6min). Narrow: below the 60s default — no production step declares this
// today, but it's the only way to exercise `minStaleAfterMs`'s floor loop and
// prove the window can move in *either* direction. Quick: leaves `staleAfterMs`
// unset → default 60s.
const WIDE_MS = 5 * 60_000;
const NARROW_MS = 30_000;
const GIANT_MS = 60 * 60_000;

const noopStep = (id: string, staleAfterMs?: number): Workflow<unknown>["steps"][string] => ({
  id,
  ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  // Never invoked: leaseRun/findResumableRunIds inspect the step's declared
  // window, they don't run its body.
  run: async (): Promise<StepResult<unknown>> => ({ kind: "done", state: {}, output: {} }),
});

const windowWorkflow: Workflow<unknown> = {
  slug: SLUG,
  name: "stale-window test",
  trigger: { kind: "manual" },
  initialState: () => ({}),
  initialStep: "wide-step",
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
    if (!getWorkflow(SLUG)) registerWorkflow(windowWorkflow);
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
    // User-authored workflow rows keep their own DB slug on agent_runs, but
    // execute the shared userAuthoredBriefWorkflow body. The stale-window
    // resolver must therefore recognize boss-turn even when the slug is not in
    // the in-memory registry; otherwise authored workflow boss turns fall back
    // to the too-tight 60s default.
    assert.equal(
      resolveStaleAfterMs("my-authored-workflow", "boss-turn"),
      userAuthoredBriefWorkflow.steps["boss-turn"]?.staleAfterMs,
    );
  });

  test("minStaleAfterMs is the smallest declared window (the SQL sweep floor)", () => {
    // The fast-step declares below the default, so the floor drops to it. This
    // is the invariant the sweep depends on: selecting at the floor can never
    // miss a genuinely-stale run because every step's window is >= the floor.
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
  // The in-flight orphan step row a live worker would hold (leaseRun marks it
  // failed on reclaim).
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
    if (!getWorkflow(SLUG)) registerWorkflow(windowWorkflow);
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    await closeConnections();
  });

  test("findResumableRunIds paginates past rows filtered by per-step refinement", async () => {
    // Regression: applying LIMIT before the JS per-step refinement meant a
    // live long-window row could consume the whole SQL page, get filtered out,
    // and hide a genuinely reclaimable row behind it until a later sweep.
    const filtered = await seedRunningRun("giant-step", ago(90_000)); // fresh under 60min
    const claimable = await seedRunningRun("quick-step", ago(80_000)); // stale under default

    const resumable = await findResumableRunIds({ limit: 1 });

    assert.deepEqual(resumable, [claimable]);
    assert.equal(resumable.includes(filtered), false, "fresh long-window row is still refined out");
  });

  test("leaseRun does NOT reclaim a wide-window step within its window", async () => {
    // 90s silent: past the 60s default (old behavior would reclaim here — the
    // exact double-spend Lever A kills) but well inside the 5min window.
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
    // Lever A must not widen every step — the default reclaim still bites at 60s.
    const reclaimable = await seedRunningRun("quick-step", ago(90_000));
    assert.equal((await leaseRun(reclaimable)).kind, "leased", "default step reclaims past 60s");

    const fresh = await seedRunningRun("quick-step", ago(45_000));
    assert.equal((await leaseRun(fresh)).kind, "none", "default step is fresh under 60s");
  });

  test("leaseRun reclaims a narrow-window step sooner than the default would", async () => {
    // 45s silent: still fresh for a default step, but past this step's 30s
    // window — proves the declared window is genuinely consulted, not just the
    // default compared against a hard-coded 60s.
    const runId = await seedRunningRun("fast-step", ago(45_000));
    assert.equal((await leaseRun(runId)).kind, "leased", "narrow window reclaims before 60s");
  });

  test("findResumableRunIds refines per-step after selecting at the floor", async () => {
    // Every seeded row is `running`; the SQL floor (minStaleAfterMs = 30s)
    // over-selects, then the JS refinement applies each step's real window.
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
