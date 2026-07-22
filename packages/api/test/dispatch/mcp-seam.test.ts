import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, user } from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, inArray, like } from "drizzle-orm";

import { clearPolicyCacheForTests } from "../../src/modules/action-policies/resolve";
import { dispatchToolCall } from "../../src/modules/dispatch";
import {
  _setMcpRuntimeForTests,
  type McpBrokerCallInput,
  type McpBrokerOutcome,
  type McpCallEnvelope,
  type McpExecutionBroker,
} from "../../src/modules/mcp";
import { computeDescriptorHashes } from "../../src/modules/mcp/hash";
import { insertConnection, publishCatalogRevision } from "../../src/modules/mcp/persistence";
import { clearToolRegistryForTests, registerTools } from "../../src/modules/tools/registry";
import { mcpTools } from "../../src/modules/tools/mcp";
import { closeRedis } from "../../src/queue/connection";

/**
 * DB-backed tests for the dispatch → MCP seam (PRD #540 #6). These prove the two
 * projected tools cross the dispatcher's boundary the way the design demands:
 *
 *   - `mcp.call` is a static `high`-tier action, so it ALWAYS stages for approval
 *     — even for a user whose policy is autonomy — and only routes through the
 *     durable broker AFTER approval, threading the staging-row id as `ctx.stagingId`
 *     so the broker's ledger row is 1:1 with the staging row.
 *   - `mcp.list_tools` is a bounded LOCAL read: it takes the fast path, writes NO
 *     staging row, and returns the catalog summaries.
 *
 * The broker itself is exercised offline against a fake protocol elsewhere
 * (`test/mcp/broker.test.ts`); here it is replaced with a capturing fake via
 * `_setMcpRuntimeForTests`, so these assert only the SEAM (gate + fast-path +
 * stagingId threading), not the ledger semantics. Opt-in on `DATABASE_URL`.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-mcpseam-";
const createdUserIds: string[] = [];

/** A capturing broker double: records what the seam handed it, returns `completed`. */
class CapturingBroker {
  lastInput: McpBrokerCallInput | null = null;
  calls = 0;
  result: unknown = { ok: true };

  async callTool(input: McpBrokerCallInput): Promise<McpBrokerOutcome> {
    this.calls += 1;
    this.lastInput = input;
    const envelope: McpCallEnvelope = {
      connectionId: input.ref.connectionId,
      toolName: input.ref.remoteName,
      catalogRevision: input.ref.catalogRevision,
      outcome: "completed",
      result: this.result,
    };
    return { status: "completed", invocationId: `inv_${randomUUID().slice(0, 8)}`, envelope };
  }
}

function asBroker(fake: CapturingBroker): McpExecutionBroker {
  return fake as unknown as McpExecutionBroker;
}

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

async function seedConnectionWithCatalog(userId: string, tools: Tool[]): Promise<string> {
  const conn = await insertConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpointUrl: "https://mcp.example.test/mcp",
    endpointOrigin: "https://mcp.example.test",
  });
  await publishCatalogRevision({
    connectionId: conn.id,
    revisionHash: `sha256:${randomUUID().replace(/-/g, "")}`,
    descriptors: tools,
    descriptorHashes: computeDescriptorHashes(tools),
    toolCount: tools.length,
  });
  return conn.id;
}

async function stagingRowsFor(runId: string, toolCallId: string) {
  return db()
    .select({ id: actionStagings.id, status: actionStagings.status })
    .from(actionStagings)
    .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));
}

describe("dispatch → mcp seam (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    clearToolRegistryForTests();
    registerTools(mcpTools);
    await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    clearToolRegistryForTests();
    _setMcpRuntimeForTests({});
    clearPolicyCacheForTests();
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
    // mcp.call stages for approval, which enqueues BullMQ jobs — close the Redis
    // connections so the test process can exit (mirrors the gated-tool tests).
    await closeRedis();
  });

  test("mcp.call always stages (high floor) even before approval", async () => {
    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;

    const result = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.call",
      activeTools: ["mcp.call"],
      input: {
        connectionId: "mcpc_x",
        remoteName: "create_issue",
        catalogRevision: "sha256:rev",
        arguments: { title: "hi" },
      },
      userId,
      caller: "boss",
    });

    assert.equal(result.kind, "staged");
    const rows = await stagingRowsFor(runId, toolCallId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "pending", "the high floor parks a fresh mcp.call for approval");
  });

  test("an approved mcp.call routes through the broker with ctx.stagingId set to the row id", async () => {
    const broker = new CapturingBroker();
    _setMcpRuntimeForTests({ broker: asBroker(broker) });

    const { userId, runId } = await seedUserAndRun();
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    const args = {
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.call" as const,
      activeTools: ["mcp.call" as const],
      input: {
        connectionId: "mcpc_y",
        remoteName: "create_issue",
        catalogRevision: "sha256:rev",
        arguments: { title: "hi" },
      },
      userId,
      caller: "boss" as const,
    };

    const staged = await dispatchToolCall(args);
    assert.equal(staged.kind, "staged");
    const stagingId = staged.kind === "staged" ? staged.stagingId : null;
    assert.ok(stagingId);

    // The user approves; the resume re-dispatch of the same (runId, toolCallId)
    // must execute against the broker.
    await db()
      .update(actionStagings)
      .set({ status: "approved" })
      .where(eq(actionStagings.id, stagingId));

    const executed = await dispatchToolCall(args);
    assert.equal(executed.kind, "executed");

    assert.equal(broker.calls, 1, "the approved call reaches the broker exactly once");
    assert.equal(
      broker.lastInput?.stagingId,
      stagingId,
      "the broker's ledger row is keyed to the staging row that authorized the call",
    );
    assert.equal(broker.lastInput?.userId, userId);
    assert.equal(broker.lastInput?.ref.remoteName, "create_issue");
    assert.deepEqual(broker.lastInput?.arguments, { title: "hi" });

    // The broker outcome is projected to the model-safe `mcp.call` result.
    assert.deepEqual(executed.kind === "executed" ? executed.toolResult : undefined, {
      status: "completed",
      result: { ok: true },
    });
  });

  test("mcp.list_tools takes the fast path — no staging row, returns catalog summaries", async () => {
    const { userId, runId } = await seedUserAndRun();
    const connId = await seedConnectionWithCatalog(userId, [
      { name: "search", inputSchema: { type: "object", additionalProperties: true } },
    ]);
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;

    const result = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.list_tools",
      activeTools: ["mcp.list_tools"],
      input: { connectionId: connId },
      userId,
      caller: "boss",
    });

    assert.equal(result.kind, "executed");
    assert.equal(
      result.kind === "executed" ? result.stagingId : "set",
      null,
      "the fast path writes no staging row",
    );
    const rows = await stagingRowsFor(runId, toolCallId);
    assert.equal(rows.length, 0, "mcp.list_tools never stages");

    const toolResult = result.kind === "executed" ? result.toolResult : undefined;
    assert.equal((toolResult as { status?: string })?.status, "tools");
    assert.deepEqual(
      (toolResult as { tools?: { name: string }[] })?.tools?.map((summary) => summary.name),
      ["search"],
    );
  });
});
