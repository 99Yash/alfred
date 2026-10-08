import assert from "node:assert/strict";
import { publicAppError } from "@alfred/contracts/app-errors";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, user } from "@alfred/db/schemas";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { toJsonValue } from "@alfred/contracts";

import { dispatchToolCall } from "../../../src/tool-runtime/dispatch";
import { clearToolRegistryForTests, liveTool, registerTool } from "@alfred/assistant/tool-runtime";
import { postgresStagingStore } from "../../../src/tool-runtime/internal/dispatch/staging-store";
import { closeRedis } from "@alfred/db/redis";
import { runStagingStoreContract, type StagingStoreHarness } from "./staging-store-contract";
import { dbBackedSkip } from "../../support/db-backed";

/**
 * DB-backed tests for what the in-memory store cannot prove: idempotent
 * re-dispatch on `(runId, toolCallId)`, the upsert's `xmax = 0` insert flag,
 * and the no-op `SET row_version = row_version` that must not clobber a decision.
 * Skipped without `DATABASE_URL`. The status machine lives in `staging-machine.test.ts`.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-dispatch-";

const createdUserIds: string[] = [];

// Proves a re-dispatch did not re-execute.
let executeCount = 0;

// The tool gets the raw URL even though the persisted `proposed_input` is scrubbed.
let lastFetchUrlExecuteUrl: string | null = null;

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
    .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));
}

describe("dispatch staging (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    // The registry starts empty in tests. `spawn_sub_agent` exists only as a known name for the
    // mismatch test.
    clearToolRegistryForTests();
    registerTool(
      liveTool({
        integration: "system",
        action: "load_tool",
        riskTier: "no_risk",
        description: "test double — counts executions",
        inputSchema: z.object({ slug: z.string() }),
        execute: async (input) => {
          if (input.slug === "sql-leak") {
            throw new Error(
              'Failed query: insert into "artifacts" ("user_id") values ($1) params: usr_private',
            );
          }

          executeCount += 1;

          // A NUL the sanitizer must strip (ADR-0070 §1.1). Keep the `\x00` escape: a literal
          // NUL makes git treat the file as binary.
          if (input.slug === "poison") {
            return { ok: true, note: "tail\x00end", call: executeCount };
          }

          return { ok: true, slug: input.slug, call: executeCount };
        },
      }),
    );
    registerTool(
      liveTool({
        integration: "system",
        action: "fetch_url",
        riskTier: "no_risk",
        description: "test double — echoes the raw url it received + redacts on persist",
        inputSchema: z.object({ url: z.string() }),
        execute: async (input) => {
          lastFetchUrlExecuteUrl = input.url;

          return { ok: true, url: input.url };
        },
        // Mirror the real fetch_url: scrub a credential query param to [REDACTED].
        redactInput: (input) => ({
          ...input,
          url: input.url.replace(/([?&](?:code|access_token|token)=)[^&#]*/gi, "$1[REDACTED]"),
        }),
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
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    clearToolRegistryForTests();

    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    // Staging opens a Redis connection. Without this the test process never exits.
    await closeRedis();
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
      toolName: "system.load_tool",
      activeTools: ["system.load_tool" as const],
      input: { slug: "github" },
      userId,
      caller: "boss" as const,
      runContext: { caller: "boss", interaction: "background" } as const,
      fence: { generation: 0 } as const,
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

  test("a sanitized result keeps its honesty flag on idempotent re-dispatch", async () => {
    // The replay re-reads the row, so the sanitize verdict must be persisted (ADR-0070 §1.1).
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;

    const args = {
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "system.load_tool" as const,
      activeTools: ["system.load_tool" as const],
      input: { slug: "poison" },
      userId,
      caller: "boss" as const,
      runContext: { caller: "boss", interaction: "background" } as const,
      fence: { generation: 0 } as const,
    };

    const first = await dispatchToolCall(args);
    assert.equal(first.kind, "executed");
    assert.equal(
      first.kind === "executed" ? first.sanitized : undefined,
      true,
      "first execution flags the boundary strip",
    );

    const second = await dispatchToolCall(args);
    assert.equal(second.kind, "executed");
    assert.equal(
      second.kind === "executed" ? second.sanitized : undefined,
      true,
      "the idempotent replay must re-emit the persisted sanitize verdict",
    );

    const rows = await db()
      .select({ executeSanitized: actionStagings.executeSanitized })
      .from(actionStagings)
      .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));

    assert.equal(rows[0]?.executeSanitized, true, "the verdict is persisted on the row");
  });

  test("raw thrown SQL never reaches the returned or persisted tool error", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;

    const result = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "system.load_tool",
      activeTools: ["system.load_tool"],
      input: { slug: "sql-leak" },
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });

    if (result.kind !== "failed") {
      assert.fail(`load_tool failure returned ${result.kind}`);
    }

    assert.deepEqual(result, {
      kind: "failed",
      stagingId: result.stagingId,
      error: publicAppError("tool_execution_failed"),
    });

    const [row] = await db()
      .select({ executeError: actionStagings.executeError })
      .from(actionStagings)
      .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));

    const persisted = JSON.stringify(row?.executeError);
    assert.doesNotMatch(persisted, /Failed query|usr_private|insert into/i);
    assert.match(persisted, /tool_execution_failed/);
  });

  test("invalid edited approval input persists and returns only the registered public error", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    await db()
      .insert(actionStagings)
      .values({
        userId,
        runId,
        stepId: "dispatch-tools",
        toolCallId,
        toolName: "system.load_tool",
        integration: "system",
        riskTier: "no_risk",
        proposedInput: { slug: "github" },
        proposedInputHash: "invalid-edit-test",
        // NOT NULL ledger columns.
        effectKey: `eff:${runId}:${toolCallId}`,
        attemptKey: `eff:${runId}:${toolCallId}:1`,
        requestHash: "req_invalid_edit_test",
        requiresApproval: true,
        status: "approved",
        decidedInput: { slug: 42, secret: "edited-private-value" },
      });

    const result = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "system.load_tool",
      input: { slug: "github" },
      activeTools: ["system.load_tool"],
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });

    assert.deepEqual(result, {
      kind: "failed",
      stagingId: result.kind === "failed" ? result.stagingId : null,
      error: publicAppError("tool_input_invalid"),
    });

    const [row] = await db()
      .select({ executeError: actionStagings.executeError })
      .from(actionStagings)
      .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));

    assert.deepEqual(row?.executeError, publicAppError("tool_input_invalid"));
    assert.doesNotMatch(JSON.stringify(row?.executeError), /edited-private-value|slug|42/);
  });

  test("#293 redacts proposed_input for an autonomous tool while execute sees the raw url", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    const rawUrl = "https://example.com/cb?code=topsecret42&page=2";

    const result = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "system.fetch_url",
      activeTools: ["system.fetch_url"],
      input: { url: rawUrl },
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });

    // The in-tool credential block needs the real value.
    assert.equal(result.kind, "executed");
    assert.equal(lastFetchUrlExecuteUrl, rawUrl, "execute receives the unredacted url");

    // Autonomous calls persist a scrubbed `proposed_input`. `display_input` is always scrubbed
    // with it.
    const rows = await db()
      .select({
        proposedInput: actionStagings.proposedInput,
        displayInput: actionStagings.displayInput,
      })
      .from(actionStagings)
      .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));

    const persisted = rows[0]?.proposedInput as { url?: string } | undefined;
    assert.ok(persisted?.url, "proposed_input has a url");
    assert.match(persisted.url, /code=\[REDACTED\]/);
    assert.match(persisted.url, /page=2/, "non-credential params survive redaction");
    assert.doesNotMatch(persisted.url, /topsecret42/, "the secret never reaches the persisted row");
    assert.deepEqual(
      rows[0]?.displayInput,
      persisted,
      "an autonomous row's display projection matches its redacted proposed_input",
    );
  });

  test("a fresh toolCallId in the same run executes again", async () => {
    const { userId, runId } = await seedUserAndRun();
    const before = executeCount;
    await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId: `tc_${randomUUID().slice(0, 8)}`,
      toolName: "system.load_tool",
      activeTools: ["system.load_tool"],
      input: { slug: "calendar" },
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
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
      toolName: "system.load_tool",
      activeTools: ["system.load_tool"],
      input: { slug: "github" },
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });
    // Two tools under one call id must throw, not run against the first row's audit trail.
    await assert.rejects(
      dispatchToolCall({
        runId,
        stepId: "dispatch-tools",
        toolCallId,
        toolName: "system.spawn_sub_agent",
        activeTools: ["system.spawn_sub_agent"],
        input: {},
        userId,
        caller: "boss",
        runContext: { caller: "boss", interaction: "background" },
        fence: { generation: 0 },
      }),
      /toolName mismatch on re-dispatch/,
    );
  });

  test("the (run_id, tool_call_id) upsert flags insert vs conflict and preserves the stored row on conflict", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;

    // The same upsert `dispatchToolCall` issues, run without the registry.
    const upsert = (status: "pending" | "approved") =>
      db()
        .insert(actionStagings)
        .values({
          userId,
          runId,
          stepId: "dispatch-tools",
          toolCallId,
          toolName: "system.load_tool",
          integration: "system",
          riskTier: "no_risk",
          proposedInput: { slug: "github" },
          proposedInputHash: "hash-fixed",
          // NOT NULL ledger columns.
          effectKey: `eff:${runId}:${toolCallId}`,
          attemptKey: `eff:${runId}:${toolCallId}:1`,
          requestHash: "req_hash_fixed",
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

    // The user approves and edits between dispatch and resume.
    await db()
      .update(actionStagings)
      .set({ status: "approved", decidedInput: { slug: "edited" }, rowVersion: 7 })
      .where(eq(actionStagings.id, inserted[0]!.id));

    // Resume re-sends `pending`. The conflict path must not overwrite the decision.
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

  // Postgres half of the store contract. Nested so the parent's setup and user cleanup cover it.
  runStagingStoreContract("postgres", (): StagingStoreHarness => {
    return {
      store: postgresStagingStore,
      async seedRun(status, fenceGeneration) {
        const userId = `${ID_PREFIX}${randomUUID()}`;
        createdUserIds.push(userId);
        await db()
          .insert(user)
          .values({ id: userId, name: "Contract User", email: `${userId}@example.test` });
        const runId = `run_${randomUUID().slice(0, 12)}`;
        await db()
          .insert(agentRuns)
          .values({
            id: runId,
            userId,
            workflowSlug: "chat",
            currentStep: "dispatch-tools",
            status,
            ...(fenceGeneration === undefined ? {} : { cancellationGeneration: fenceGeneration }),
          });

        return { userId, runId };
      },
      async decide(stagingId, decision) {
        // Written out-of-band, like the approval API. Deciding a row is not the store's job.
        await db()
          .update(actionStagings)
          .set({
            status: decision.status,
            ...(decision.decidedInput === undefined
              ? {}
              : { decidedInput: toJsonValue(decision.decidedInput) }),
            ...(decision.rejectReason === undefined ? {} : { rejectReason: decision.rejectReason }),
            decidedAt: decision.decidedAt ?? new Date(),
            rowVersion: sql`${actionStagings.rowVersion} + 1`,
          })
          .where(eq(actionStagings.id, stagingId));
      },
      async readBack(stagingId) {
        const [row] = await db()
          .select({
            status: actionStagings.status,
            outcome: actionStagings.outcome,
            effectKey: actionStagings.effectKey,
            attemptKey: actionStagings.attemptKey,
            requestHash: actionStagings.requestHash,
            rowVersion: actionStagings.rowVersion,
            decidedInput: actionStagings.decidedInput,
            executeResult: actionStagings.executeResult,
            executeSanitized: actionStagings.executeSanitized,
            executeError: actionStagings.executeError,
            executedAt: actionStagings.executedAt,
            displayInput: actionStagings.displayInput,
          })
          .from(actionStagings)
          .where(eq(actionStagings.id, stagingId));

        return row ?? null;
      },
      unknownRunId() {
        return `run_absent_${randomUUID().slice(0, 12)}`;
      },
    };
  });
});
