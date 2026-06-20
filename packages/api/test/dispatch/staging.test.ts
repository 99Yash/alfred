import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, user } from "@alfred/db/schemas";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";

import { dispatchToolCall } from "../../src/modules/dispatch";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
} from "../../src/modules/tools/registry";

/**
 * DB-backed regression tests for the dispatcher's idempotency contract and the
 * `(run_id, tool_call_id)` upsert it rests on — the two load-bearing claims
 * behind concurrent batch dispatch + the staged/resume re-dispatch path
 * (perf/191-195). Specifically:
 *
 *   1. `dispatchToolCall` is idempotent on `(runId, toolCallId)`: re-dispatching
 *      an already-`executed` call returns the STORED result without running the
 *      tool a second time. This is precisely what makes "re-dispatch the whole
 *      batch on resume" safe — already-executed siblings must not re-fire.
 *   2. The single upsert's `xmax = 0` flag distinguishes a fresh insert from a
 *      conflict, and its no-op `SET row_version = row_version` returns the
 *      existing row VERBATIM — it must never clobber a decision/result column,
 *      because the resume path reads `status` / `decided_input` off that row.
 *
 * The dispatcher drives the `system.*` integration through the autonomy path
 * (no policy lookup, no approval gate, no Redis), so these stay DB-only.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise so the pure-function suite still runs without a
 * database. Seeds throwaway `test-dispatch-*` users and cascades them away on
 * teardown (action_stagings + agent_runs both `onDelete: cascade` from user).
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-dispatch-";
const createdUserIds: string[] = [];

// Bumped every time the registered `load_integration` double actually runs, so
// a test can prove a re-dispatch did NOT re-execute (count stays put).
let executeCount = 0;

async function seedUserAndRun(): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "chat",
    currentStep: "dispatch-tools",
  });
  return { userId, runId };
}

async function stagingRowsFor(runId: string, toolCallId: string) {
  return db()
    .select({
      id: actionStagings.id,
      status: actionStagings.status,
      toolName: actionStagings.toolName,
      decidedInput: actionStagings.decidedInput,
      rowVersion: actionStagings.rowVersion,
    })
    .from(actionStagings)
    .where(
      and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)),
    );
}

describe("dispatch staging (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    // The tool registry is process-local and starts empty in the test runner
    // (production tools self-register at server boot, which we never trigger).
    // Register controlled `system.*` doubles: `load_integration` counts its
    // executions; `spawn_sub_agent` exists only so a toolName-mismatch can be
    // dispatched against a real, known name.
    clearToolRegistryForTests();
    registerTool(
      liveTool({
        integration: "system",
        action: "load_integration",
        riskTier: "no_risk",
        description: "test double — counts executions",
        inputSchema: z.object({ slug: z.string() }),
        execute: async (input) => {
          executeCount += 1;
          return { ok: true, slug: input.slug, call: executeCount };
        },
      }),
    );
    registerTool(
      liveTool({
        integration: "system",
        action: "spawn_sub_agent",
        riskTier: "no_risk",
        description: "test double — should never execute in these tests",
        inputSchema: z.object({}).passthrough(),
        execute: async () => {
          throw new Error("spawn_sub_agent double should not have executed");
        },
      }),
    );
    await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    clearToolRegistryForTests();
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("re-dispatching an executed call returns the stored result without re-running the tool", async () => {
    const { userId, runId } = await seedUserAndRun();
    const before = executeCount;
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    const args = {
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "system.load_integration",
      input: { slug: "github" },
      userId,
      caller: "boss" as const,
    };

    const first = await dispatchToolCall(args);
    assert.equal(first.kind, "executed");
    assert.equal(executeCount, before + 1, "first dispatch runs the tool once");
    const firstResult = first.kind === "executed" ? first.toolResult : undefined;

    const second = await dispatchToolCall(args);
    assert.equal(second.kind, "executed");
    assert.equal(
      executeCount,
      before + 1,
      "re-dispatch must short-circuit on the executed row, not run the tool again",
    );
    assert.deepEqual(
      second.kind === "executed" ? second.toolResult : undefined,
      firstResult,
      "re-dispatch returns the STORED result (same call number), not a fresh execution",
    );

    const rows = await stagingRowsFor(runId, toolCallId);
    assert.equal(rows.length, 1, "the unique (run_id, tool_call_id) index keeps exactly one row");
    assert.equal(rows[0]?.status, "executed");
  });

  test("a fresh toolCallId in the same run executes again", async () => {
    const { userId, runId } = await seedUserAndRun();
    const before = executeCount;
    await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId: `tc_${randomUUID().slice(0, 8)}`,
      toolName: "system.load_integration",
      input: { slug: "calendar" },
      userId,
      caller: "boss",
    });
    assert.equal(executeCount, before + 1, "a new tool_call_id is a distinct call and re-executes");
  });

  test("re-dispatching a toolCallId under a different toolName fails loud", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "system.load_integration",
      input: { slug: "github" },
      userId,
      caller: "boss",
    });
    // Same (runId, toolCallId), different toolName → the model emitted two
    // tools under one call id. The dispatcher must throw rather than silently
    // execute the new tool against the original row's audit trail.
    await assert.rejects(
      dispatchToolCall({
        runId,
        stepId: "dispatch-tools",
        toolCallId,
        toolName: "system.spawn_sub_agent",
        input: {},
        userId,
        caller: "boss",
      }),
      /toolName mismatch on re-dispatch/,
    );
  });

  test("the (run_id, tool_call_id) upsert flags insert vs conflict and preserves the stored row on conflict", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;

    // Exactly the upsert `dispatchToolCall` issues, run in isolation so the
    // `xmax = 0` insert-vs-conflict flag and the no-op SET are exercised
    // directly — independent of the tool registry.
    const upsert = (status: "pending" | "approved") =>
      db()
        .insert(actionStagings)
        .values({
          userId,
          runId,
          stepId: "dispatch-tools",
          toolCallId,
          toolName: "system.load_integration",
          integration: "system",
          riskTier: "no_risk",
          proposedInput: { slug: "github" },
          proposedInputHash: "hash-fixed",
          requiresApproval: false,
          status,
        })
        .onConflictDoUpdate({
          target: [actionStagings.runId, actionStagings.toolCallId],
          set: { rowVersion: sql`${actionStagings.rowVersion}` },
        })
        .returning({
          id: actionStagings.id,
          status: actionStagings.status,
          rowVersion: actionStagings.rowVersion,
          wasInserted: sql<boolean>`xmax = 0`,
        });

    const inserted = await upsert("pending");
    assert.equal(inserted[0]?.wasInserted, true, "first upsert is a genuine insert");
    assert.equal(inserted[0]?.status, "pending");

    // Simulate the user approving + editing between dispatch and resume: flip
    // the row to a decided state the resume path must read back verbatim.
    await db()
      .update(actionStagings)
      .set({ status: "approved", decidedInput: { slug: "edited" }, rowVersion: 7 })
      .where(eq(actionStagings.id, inserted[0]!.id));

    // The resume re-dispatch sends `status: "pending"` + the original proposed
    // input again. The conflict path must NOT overwrite the approval decision.
    const conflicted = await upsert("pending");
    assert.equal(conflicted[0]?.wasInserted, false, "re-upsert on conflict is not an insert");
    assert.equal(
      conflicted[0]?.id,
      inserted[0]?.id,
      "conflict returns the existing row, not a new one",
    );

    const rows = await stagingRowsFor(runId, toolCallId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "approved", "no-op SET must not revert status to pending");
    assert.deepEqual(
      rows[0]?.decidedInput,
      { slug: "edited" },
      "no-op SET must not clobber decided_input",
    );
    assert.equal(rows[0]?.rowVersion, 7, "no-op SET rewrites row_version to itself, not the seed");
  });
});
