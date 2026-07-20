import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { isRecord, restPassthroughInput } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  user,
  userActionPolicies,
  userPreferences,
} from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { clearPolicyCacheForTests } from "../../src/modules/action-policies/resolve";
import { dispatchToolCall } from "../../src/modules/dispatch";
import { PASSTHROUGH_PER_TURN_CEILING } from "../../src/modules/tools/passthrough";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
} from "../../src/modules/tools/registry";

/**
 * DB-backed regression for the ADR-0074 per-turn passthrough ceiling. A runaway
 * pagination loop reads as *forward progress* (each page is a materially-changed
 * request), so it slips past the ADR-0070 non-progress backstop. The dispatcher's
 * cumulative cap is the dedicated guard: at or over the ceiling it commits a
 * VISIBLE `budget_exhausted` envelope as a normal executed result and does NOT
 * run the tool — the boss reads the notice and stops paginating, never a silent
 * cut-off.
 *
 * The tool must reach the execute branch to exercise the guard, so this drives a
 * real `github.request` double through the full non-`system` path: the policy is
 * seeded to `autonomy` (a read tool + autonomy ⇒ no approval gate) and the
 * default-OFF passthrough preference is turned ON so the kill-switch recheck
 * doesn't short-circuit first.
 *
 * Opt-in on a reachable migrated Postgres (same gate as staging.test.ts); the
 * pure envelope/routing assertions live in test/tools/passthrough/budget.test.ts.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-pt-budget-";
const createdUserIds: string[] = [];

// Bumped every time the github.request double actually executes, so a test can
// prove the ceiling PREVENTED a real execution (count stays put).
let executeCount = 0;

async function seedUser(): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  // Autonomy so a no_risk read executes without an approval gate.
  await db().insert(userActionPolicies).values({ userId, defaultMode: "autonomy" });
  // Default-OFF passthrough tier: turn github ON so the kill-switch recheck passes.
  await db()
    .insert(userPreferences)
    .values({ userId, key: "feature.passthrough.github", value: true });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "chat",
    currentStep: "dispatch-tools",
  });
  clearPolicyCacheForTests();
  return { userId, runId };
}

/** Seed `count` already-executed passthrough rows for the run, as a prior loop would. */
async function seedExecutedPassthroughCalls(
  userId: string,
  runId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  await db()
    .insert(actionStagings)
    .values(
      Array.from({ length: count }, (_unused, i) => ({
        userId,
        runId,
        stepId: "dispatch-tools",
        toolCallId: `seed_${i}_${randomUUID().slice(0, 8)}`,
        toolName: "github.request" as const,
        integration: "github" as const,
        riskTier: "no_risk" as const,
        proposedInput: { method: "GET", path: `/repos/x/y/commits?page=${i}` },
        proposedInputHash: `seed-hash-${i}`,
        requiresApproval: false,
        status: "executed" as const,
      })),
    );
}

function dispatchGithubRequest(userId: string, runId: string, page: number) {
  return dispatchToolCall({
    runId,
    stepId: "dispatch-tools",
    toolCallId: `tc_${randomUUID().slice(0, 8)}`,
    toolName: "github.request",
    activeTools: ["github.request"],
    input: { method: "GET", path: `/repos/x/y/commits?page=${page}` },
    userId,
    caller: "boss",
  });
}

describe("passthrough per-turn ceiling (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    clearToolRegistryForTests();
    // A github.request double standing in for the real passthrough tool: same
    // identity (github.request), same passthrough marker + read schema, but a
    // controllable execute that counts its runs so we can prove the ceiling
    // blocked one.
    registerTool(
      liveTool({
        integration: "github",
        action: "request",
        riskTier: "no_risk",
        availability: { passthrough: true },
        description: "test double — counts real passthrough executions",
        inputSchema: restPassthroughInput,
        execute: async () => {
          executeCount += 1;
          return { outcome: "http", status: 200, succeeded: true, body: [], call: executeCount };
        },
      }),
    );
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  beforeEach(() => {
    executeCount = 0;
  });

  after(async () => {
    clearToolRegistryForTests();
    clearPolicyCacheForTests();
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("at the ceiling: the call is NOT executed and returns the visible budget_exhausted envelope", async () => {
    const { userId, runId } = await seedUser();
    await seedExecutedPassthroughCalls(userId, runId, PASSTHROUGH_PER_TURN_CEILING);

    const result = await dispatchGithubRequest(userId, runId, PASSTHROUGH_PER_TURN_CEILING + 1);

    assert.equal(result.kind, "executed", "the guard commits a normal executed result");
    const toolResult = result.kind === "executed" ? result.toolResult : undefined;
    assert.ok(isRecord(toolResult), "the executed result carries the envelope");
    assert.equal(toolResult.outcome, "budget_exhausted");
    assert.equal(toolResult.callsThisTurn, PASSTHROUGH_PER_TURN_CEILING);
    assert.equal(toolResult.ceiling, PASSTHROUGH_PER_TURN_CEILING);
    assert.equal(
      executeCount,
      0,
      "the ceiling must block the real execution, not just annotate it",
    );
  });

  test("under the ceiling: the call executes normally", async () => {
    const { userId, runId } = await seedUser();
    await seedExecutedPassthroughCalls(userId, runId, PASSTHROUGH_PER_TURN_CEILING - 1);

    const result = await dispatchGithubRequest(userId, runId, PASSTHROUGH_PER_TURN_CEILING);

    assert.equal(result.kind, "executed");
    const toolResult = result.kind === "executed" ? result.toolResult : undefined;
    assert.ok(isRecord(toolResult));
    assert.notEqual(toolResult.outcome, "budget_exhausted", "one below the cap still runs");
    assert.equal(executeCount, 1, "the double actually executed");
  });
});
