import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { isRecord, restPassthroughInput } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import type { SealedCredentialSecret } from "@alfred/db/credential-vault";
import {
  actionStagings,
  agentRuns,
  integrationCredentials,
  user,
  userActionPolicies,
  userPreferences,
} from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { clearPolicyCacheForTests } from "@alfred/assistant/action-policies/test-support";
import { dispatchToolCall } from "../../../src/tool-runtime/dispatch";
import { PASSTHROUGH_PER_RUN_CEILING } from "../../../src/tool-runtime/internal/tools/passthrough";
import { clearToolRegistryForTests, liveTool, registerTool } from "@alfred/assistant/tool-runtime";
import { dbBackedSkip } from "../../support/db-backed";

/**
 * DB-backed test of the per-run passthrough ceiling (ADR-0074). Pagination looks like
 * progress, so the ADR-0070 backstop misses it. At the ceiling the dispatcher commits a
 * visible `budget_exhausted` result and does not run the tool.
 * The pure assertions live in `tools/passthrough/budget.test.ts`.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-pt-budget-";

const createdUserIds: string[] = [];

// Proves the ceiling prevented a real execution.
let executeCount = 0;

async function seedUser(): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  await db().insert(userActionPolicies).values({ userId, defaultMode: "autonomy" });
  // Without a healthy connection the dispatch answers `not_allowed` before the ceiling.
  // `credentialSatisfies` for `github_app` needs an active row with an installation id.

  await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "github",
      accountId: `${userId}-gh`,
      // Unsealed on purpose: nothing opens the token, and sealing needs the `serverEnv()` fixtures.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions -- boundary cast: source type is structurally incompatible with target
      accessToken: "test-token" as unknown as SealedCredentialSecret,
      installationId: "1",
      status: "active",
    });
  // The passthrough tier is off by default.
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

/** Seed `count` executed passthrough rows, as a prior loop would. */
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
        // NOT NULL ledger columns.
        effectKey: `eff:${runId}:seed_${i}`,
        attemptKey: `eff:${runId}:seed_${i}:1`,
        requestHash: `req_seed_${i}`,
        requiresApproval: false,
        status: "executed" as const,
        outcome: "succeeded" as const,
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
    runContext: { caller: "boss", interaction: "background" },
    fence: { generation: 0 },
  });
}

describe("passthrough per-run ceiling (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    clearToolRegistryForTests();
    // Same identity and passthrough marker as the real tool, with a counting execute.
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
    await seedExecutedPassthroughCalls(userId, runId, PASSTHROUGH_PER_RUN_CEILING);

    const result = await dispatchGithubRequest(userId, runId, PASSTHROUGH_PER_RUN_CEILING + 1);

    assert.equal(result.kind, "executed", "the guard commits a normal executed result");
    const toolResult = result.kind === "executed" ? result.toolResult : undefined;
    assert.ok(isRecord(toolResult), "the executed result carries the envelope");
    assert.equal(toolResult.outcome, "budget_exhausted");
    assert.equal(toolResult.callsThisRun, PASSTHROUGH_PER_RUN_CEILING);
    assert.equal(toolResult.ceiling, PASSTHROUGH_PER_RUN_CEILING);
    assert.equal(
      executeCount,
      0,
      "the ceiling must block the real execution, not just annotate it",
    );
  });

  test("under the ceiling: the call executes normally", async () => {
    const { userId, runId } = await seedUser();
    await seedExecutedPassthroughCalls(userId, runId, PASSTHROUGH_PER_RUN_CEILING - 1);

    const result = await dispatchGithubRequest(userId, runId, PASSTHROUGH_PER_RUN_CEILING);

    assert.equal(result.kind, "executed");
    const toolResult = result.kind === "executed" ? result.toolResult : undefined;
    assert.ok(isRecord(toolResult));
    assert.notEqual(toolResult.outcome, "budget_exhausted", "one below the cap still runs");
    assert.equal(executeCount, 1, "the double actually executed");
  });
});
