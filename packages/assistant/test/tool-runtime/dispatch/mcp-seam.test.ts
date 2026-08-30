import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { hashToolInput, hashToolRequest } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  mcpInvocation,
  user,
  userActionPolicies,
} from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/client";
import { and, eq, inArray, like } from "drizzle-orm";

import { clearPolicyCacheForTests } from "@alfred/assistant/action-policies/test-support";
import { dispatchToolCall } from "../../../src/tool-runtime/dispatch";
import {
  computeDescriptorHashes,
  descriptorHash,
  McpRawClient,
  type McpCallEnvelope,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
} from "@alfred/assistant/connections/mcp";
import { publishCatalogRevision } from "@alfred/assistant/connections/mcp/test-support";
import { createNamedConnection } from "../../../src/connections/mcp/persistence";
import { type McpBrokerCallInput, type McpBrokerOutcome } from "@alfred/assistant/tool-runtime/mcp";
import {
  _setMcpExecutionBrokerForTests,
  upsertToolPolicy,
} from "@alfred/assistant/tool-runtime/mcp/test-support";
import { clearToolRegistryForTests, registerTools } from "@alfred/assistant/tool-runtime";
import { mcpTools } from "../../../src/tool-runtime/internal/tools/mcp";
import { McpConnectionManager } from "../../../src/connections/mcp/manager";
import { McpExecutionBroker } from "../../../src/tool-runtime/mcp/broker";
import { reconcileInflightInvocations } from "../../../src/tool-runtime/mcp/invocations";
import {
  listMcpRecoveryOperations,
  retryMcpRecoveryOperation,
} from "../../../src/tool-runtime/mcp/recovery";
import { closeRedis } from "@alfred/db/redis";
import { dbBackedSkip } from "../../support/db-backed";

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
 * `_setMcpExecutionBrokerForTests`, so these assert only the SEAM (gate + fast-path +
 * stagingId threading), not the ledger semantics. Opt-in on `DATABASE_URL`.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-mcpseam-";
const createdUserIds: string[] = [];

/** The stubbed broker result; every test treats it as an `{ ok: ... }` record. */
interface BrokerStubResult {
  ok: boolean;
}

/** A capturing broker double: records what the seam handed it, returns `completed`. */
class CapturingBroker {
  lastInput: McpBrokerCallInput | null = null;
  calls = 0;
  result: BrokerStubResult = { ok: true };

  async callTool(input: McpBrokerCallInput): Promise<McpBrokerOutcome> {
    this.calls += 1;
    this.lastInput = input;
    const envelope: McpCallEnvelope = {
      connectionId: input.ref.connectionId,
      toolName: input.ref.remoteName,
      catalogRevision: input.ref.catalogRevision,
      outcome: "completed",
      result: this.result,
      provenance: {
        isError: false,
        hasStructuredContent: false,
        outputSchemaValidated: false,
        contentBlockCount: 0,
        contentKinds: {},
        truncated: false,
      },
    };
    return { status: "completed", invocationId: `inv_${randomUUID().slice(0, 8)}`, envelope };
  }
}

class PausedFirstCallProtocol implements McpProtocolClient {
  readonly firstCallStarted = Promise.withResolvers<void>();
  readonly releaseFirstCall = Promise.withResolvers<void>();
  calls = 0;

  constructor(readonly tools: Tool[]) {}

  async connect(): Promise<McpNegotiatedServer> {
    return {
      protocolEra: "pre_2026_07_28",
      protocolVersion: "2025-11-25",
      serverName: "paused-test",
      serverVersion: "1",
      hasTools: true,
      toolsListChanged: true,
    };
  }

  async close(): Promise<void> {}

  async listTools(): Promise<McpProtocolPage> {
    return { tools: this.tools, ttlMs: 0, cacheScope: "private" };
  }

  async callTool(): Promise<McpProtocolCallResult> {
    this.calls += 1;
    if (this.calls === 1) {
      this.firstCallStarted.resolve();
      await this.releaseFirstCall.promise;
      throw new Error("first worker crashed after delivery");
    }
    return { content: [{ type: "text", text: "successor applied" }] };
  }

  onToolsChanged(): void {}
  onConnectionUnhealthy(): void {}
}

function asBroker(fake: CapturingBroker): McpExecutionBroker {
  // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
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
  const conn = await createNamedConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpoint: new URL("https://mcp.example.test/mcp"),
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

/**
 * Seed a real owned connection + one-tool catalog revision, returning the
 * revision + descriptor hashes a reviewed policy binds to. Unlike
 * `seedConnectionWithCatalog`, this surfaces the hashes the resolver keys on so a
 * downgrade can be pinned to the EXACT descriptor.
 */
async function seedOwnedCatalog(
  userId: string,
  tools: Tool[],
): Promise<{
  connectionId: string;
  revisionHash: string;
  descriptorHashes: Record<string, string>;
}> {
  const conn = await createNamedConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpoint: new URL("https://mcp.example.test/mcp"),
  });
  const revisionHash = `sha256:${randomUUID().replace(/-/g, "")}`;
  const descriptorHashes = computeDescriptorHashes(tools);
  await publishCatalogRevision({
    connectionId: conn.id,
    revisionHash,
    descriptors: tools,
    descriptorHashes,
    toolCount: tools.length,
  });
  return { connectionId: conn.id, revisionHash, descriptorHashes };
}

/** Put the user in autonomy mode so the resolved risk tier alone drives the gate. */
async function seedAutonomyPolicy(userId: string): Promise<void> {
  await db()
    .insert(userActionPolicies)
    .values({ userId, defaultMode: "autonomy" })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: { defaultMode: "autonomy" },
    });
  clearPolicyCacheForTests();
}

async function stagingRowsFor(runId: string, toolCallId: string) {
  return db()
    .select({
      id: actionStagings.id,
      status: actionStagings.status,
      riskTier: actionStagings.riskTier,
      requiresApproval: actionStagings.requiresApproval,
    })
    .from(actionStagings)
    .where(and(eq(actionStagings.runId, runId), eq(actionStagings.toolCallId, toolCallId)));
}

describe("dispatch → mcp seam (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    clearToolRegistryForTests();
    registerTools(mcpTools);
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    clearToolRegistryForTests();
    _setMcpExecutionBrokerForTests();
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
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });

    assert.equal(result.kind, "staged");
    const rows = await stagingRowsFor(runId, toolCallId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "pending", "the high floor parks a fresh mcp.call for approval");
    assert.equal(rows[0]?.riskTier, "high", "the persisted tier is the floor, not a downgrade");
    assert.equal(rows[0]?.requiresApproval, true);
  });

  test("a reviewed per-descriptor downgrade lets a real mcp.call run without approval", async () => {
    // The full wiring the resolver rides on (#541 Part 3): the real `mcp.call`
    // tool's `resolveRiskTier` hook reads the reviewed `low` policy bound to the
    // exact descriptor, the dispatcher gates on that resolved tier (autonomy +
    // `low` → no approval), and the SAME tier is persisted on the staging row.
    const broker = new CapturingBroker();
    _setMcpExecutionBrokerForTests(asBroker(broker));

    const { userId, runId } = await seedUserAndRun();
    await seedAutonomyPolicy(userId);
    const tool: Tool = {
      name: "search_issues",
      inputSchema: { type: "object", additionalProperties: true },
    };
    const { connectionId, revisionHash, descriptorHashes } = await seedOwnedCatalog(userId, [tool]);
    await upsertToolPolicy({
      userId,
      connectionId,
      remoteName: tool.name,
      descriptorHash: descriptorHashes[tool.name]!,
      riskTier: "low",
      effectClass: "read",
      retryContract: "never",
    });

    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    const result = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.call",
      activeTools: ["mcp.call"],
      input: {
        connectionId,
        remoteName: tool.name,
        catalogRevision: revisionHash,
        arguments: { q: "is:open" },
      },
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });

    // Autonomous: the downgrade waived approval, so the call executed inline
    // instead of parking — and the broker received it exactly once.
    assert.equal(
      result.kind,
      "executed",
      "a downgraded mcp.call runs without staging for approval",
    );
    assert.equal(broker.calls, 1);

    const rows = await stagingRowsFor(runId, toolCallId);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]?.riskTier,
      "low",
      "the reviewed downgrade is the persisted effective tier",
    );
    assert.equal(rows[0]?.requiresApproval, false, "the resolved tier drove the approval decision");
    assert.equal(rows[0]?.status, "executed");
  });

  test("an approved mcp.call routes through the broker with ctx.stagingId set to the row id", async () => {
    const broker = new CapturingBroker();
    _setMcpExecutionBrokerForTests(asBroker(broker));

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
      runContext: { caller: "boss", interaction: "background" } as const,
      fence: { generation: 0 } as const,
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

  test("same-staging re-dispatch preserves ambiguity through boot and an explicit successor", async () => {
    const { userId, runId } = await seedUserAndRun();
    await seedAutonomyPolicy(userId);
    const remoteTool: Tool = {
      name: "create_issue",
      inputSchema: { type: "object", additionalProperties: true },
    };
    const connection = await createNamedConnection({
      userId,
      label: "Paused MCP",
      canonicalResource: `mcp://paused/${randomUUID()}`,
      endpoint: new URL("https://paused.example.test/mcp"),
    });
    const protocol = new PausedFirstCallProtocol([remoteTool]);
    const manager = new McpConnectionManager({
      clientFactory: (owned) =>
        new McpRawClient({
          connectionId: owned.id,
          endpoint: new URL(owned.server.endpointUrl),
          endpointAuthorization: { authorize: async (endpoint) => new URL(endpoint.href) },
          protocolFactory: () => protocol,
        }),
    });
    const client = await manager.getReadyClient(connection.id);
    const catalogRevision = client.catalog?.revision;
    assert.ok(catalogRevision);
    await upsertToolPolicy({
      userId,
      connectionId: connection.id,
      remoteName: remoteTool.name,
      descriptorHash: descriptorHash(remoteTool),
      riskTier: "low",
      effectClass: "write",
      retryContract: "never",
    });

    const broker = new McpExecutionBroker(manager);
    _setMcpExecutionBrokerForTests(broker);
    const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
    const input = {
      connectionId: connection.id,
      remoteName: remoteTool.name,
      catalogRevision,
      arguments: { title: "one effect" },
    };
    const stagingId = `as_${randomUUID().slice(0, 12)}`;
    await db()
      .insert(actionStagings)
      .values({
        id: stagingId,
        userId,
        runId,
        stepId: "dispatch-tools",
        toolCallId,
        toolName: "mcp.call",
        integration: "mcp",
        riskTier: "low",
        proposedInput: input,
        displayInput: input,
        proposedInputHash: hashToolInput("mcp.call", input),
        effectKey: `eff:${runId}:${toolCallId}`,
        attemptKey: `eff:${runId}:${toolCallId}:1`,
        requestHash: hashToolRequest("mcp.call", input, undefined),
        requiresApproval: false,
        status: "pending",
        outcome: "dispatching",
      });
    const ref = {
      kind: "mcp" as const,
      connectionId: connection.id,
      remoteName: remoteTool.name,
      catalogRevision,
    };
    const firstWorker = broker.callTool({
      userId,
      stagingId,
      ref,
      arguments: input.arguments,
    });
    await protocol.firstCallStarted.promise;

    const repeated = await dispatchToolCall({
      runId,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.call",
      activeTools: ["mcp.call"],
      input,
      userId,
      caller: "boss",
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
    });
    assert.equal(repeated.kind, "executed");
    assert.deepEqual(repeated.kind === "executed" ? repeated.toolResult : null, {
      status: "unknown",
      retry: "blocked",
      message:
        "This exact call was already recorded and may have been delivered. Its outcome must be checked before it can be attempted again.",
    });
    const [afterRepeat] = await db()
      .select({ outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(eq(actionStagings.id, stagingId));
    assert.equal(afterRepeat?.outcome, "unknown");
    assert.equal(protocol.calls, 1, "the same-staging re-dispatch never sends again");

    const boot = await reconcileInflightInvocations(userId);
    assert.equal(boot.markedUnknown, 1);
    assert.equal(boot.alignedStagingBarriers, 0, "the dispatcher already aligned staging");
    const visible = await listMcpRecoveryOperations({ userId });
    assert.equal(visible.operations.length, 1);

    const successor = await retryMcpRecoveryOperation({
      userId,
      invocationId: visible.operations[0]!.invocationId,
    });
    assert.equal(successor.status, "completed");
    assert.ok(successor.successorInvocationId);
    assert.equal(protocol.calls, 2, "only the explicit successor creates another send");

    protocol.releaseFirstCall.resolve();
    const abandonedWorker = await firstWorker;
    assert.equal(abandonedWorker.status, "ambiguous");
    const [prior] = await db()
      .select({
        resolvedAt: mcpInvocation.resolvedAt,
        resolutionReason: mcpInvocation.resolutionReason,
      })
      .from(mcpInvocation)
      .where(eq(mcpInvocation.stagingId, stagingId));
    assert.ok(prior?.resolvedAt);
    assert.equal(prior?.resolutionReason, "superseded_by_user_successor");
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
      runContext: { caller: "boss", interaction: "background" },
      fence: { generation: 0 },
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
