import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  mcpConnections,
  mcpInvocation,
  user,
  type NewActionStaging,
} from "@alfred/db/schemas";
import type { McpCallInput } from "@alfred/contracts";
import { ProtocolError, SdkErrorCode, SdkHttpError, type Tool } from "@modelcontextprotocol/client";
import { eq, inArray, like } from "drizzle-orm";

import {
  McpRawClient,
  type ExternalToolRef,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
} from "../../src/connections/mcp";
import { McpExecutionBroker } from "../../src/tool-runtime/mcp/broker";
import { McpClientError } from "../../src/connections/mcp/errors";
import { descriptorHash } from "../../src/connections/mcp/hash";
import { McpConnectionManager } from "../../src/connections/mcp/manager";
import { ensureConnection, publishCatalogRevision } from "../../src/connections/mcp/persistence";
import { permissiveMcpEndpointAuthorizerForTests } from "../../src/connections/mcp/test-support";
import {
  reconcileInflightInvocations,
  upsertToolPolicy,
} from "../../src/tool-runtime/mcp/invocations";
import {
  listMcpRecoveryOperations,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
} from "../../src/tool-runtime/mcp/recovery";
import { _setMcpExecutionBrokerForTests } from "../../src/tool-runtime/mcp/runtime";
import { dbBackedSkip } from "../support/db-backed";
import { claimExpectedRejection } from "../support/expected-rejection";

/**
 * DB-backed broker tests. A real `McpRawClient` runs over a fake `McpProtocolClient`,
 * so the full connect, refresh, ledger, and call path runs with no socket. Needs `DATABASE_URL`.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-mcpbrk-";

const createdUserIds: string[] = [];

/** A revision no catalog can mint, for the stale-selection cases. */
const STALE_REVISION = "sha256:stale";

type CallBehavior = { kind: "ok" } | { kind: "tool_error" } | { kind: "throw"; error: unknown };

class FakeProtocol implements McpProtocolClient {
  tools: Tool[];
  behavior: CallBehavior = { kind: "ok" };
  calls = 0;
  connectError: unknown;
  beforeReturn: (() => Promise<void>) | undefined;
  negotiated: McpNegotiatedServer = {
    protocolEra: "pre_2026_07_28",
    protocolVersion: "2025-11-25",
    mirrorsParamHeaders: false,
    serverName: "fake",
    serverVersion: "1",
    hasTools: true,
    toolsListChanged: true,
  };

  constructor(tools: Tool[]) {
    this.tools = tools;
  }

  async connect(): Promise<McpNegotiatedServer> {
    if (this.connectError) throw this.connectError;

    return this.negotiated;
  }
  async close(): Promise<void> {}
  async listTools(): Promise<McpProtocolPage> {
    return { tools: this.tools, ttlMs: 0, cacheScope: "private" };
  }
  async callTool(): Promise<McpProtocolCallResult> {
    this.calls += 1;
    await this.beforeReturn?.();

    if (this.behavior.kind === "throw") throw this.behavior.error;

    if (this.behavior.kind === "tool_error") {
      return { content: [{ type: "text", text: "nope" }], isError: true };
    }

    return { content: [{ type: "text", text: "ok" }] };
  }
  onToolsChanged(): void {}
  onConnectionUnhealthy(): void {}
}

// Permissive schema on purpose: these tests cover the ledger and barrier, not schema validation.
function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: "object", additionalProperties: true },
  };
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  await db()
    .insert(agentRuns)
    .values({
      id: `run_${randomUUID().slice(0, 12)}`,
      userId,
      workflowSlug: "chat",
      currentStep: "dispatch-tools",
    });

  return userId;
}

/** The exact `mcp.call` input a staging row stores. The strict schema omits `kind`, so do not spread `ExternalToolRef`. */
function stagedCallInput(ref: ExternalToolRef, args: McpCallInput["arguments"]): McpCallInput {
  return {
    connectionId: ref.connectionId,
    remoteName: ref.remoteName,
    catalogRevision: ref.catalogRevision,
    arguments: args,
  };
}

async function seedStaging(
  userId: string,
  proposedInput: NewActionStaging["proposedInput"] = {},
): Promise<string> {
  const [run] = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId))
    .limit(1);

  assert.ok(run, "seed run missing");
  const stagingId = `stg_${randomUUID().slice(0, 12)}`;
  const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
  await db()
    .insert(actionStagings)
    .values({
      id: stagingId,
      userId,
      runId: run.id,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.call",
      integration: "mcp",
      riskTier: "high",
      proposedInput,
      displayInput: proposedInput,
      proposedInputHash: randomUUID(),
      // The ledger's NOT NULL effect identity and canonical request hash.
      effectKey: `eff:${run.id}:${toolCallId}`,
      attemptKey: `eff:${run.id}:${toolCallId}:1`,
      requestHash: `req_seed_${randomUUID()}`,
      requiresApproval: true,
      status: "approved",
      outcome: "dispatching",
    });

  return stagingId;
}

async function seedConnection(userId: string): Promise<string> {
  const conn = await ensureConnection({
    userId,
    label: "Test MCP",
    instanceKey: "default",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpoint: new URL("https://mcp.example.test/mcp"),
  });

  return conn.id;
}

function brokerWith(protocol: FakeProtocol): McpExecutionBroker {
  const manager = new McpConnectionManager({
    clientFactory: (connection) =>
      new McpRawClient({
        auth: { mode: "none" },
        connectionId: connection.id,
        endpoint: connection.server,
        endpointAuthorizer: permissiveMcpEndpointAuthorizerForTests(),
        protocolFactory: () => protocol,
      }),
  });

  return new McpExecutionBroker(manager);
}

/** Resolve the live catalog revision for a connection by connecting once. */
async function liveRevision(protocol: FakeProtocol, connectionId: string): Promise<string> {
  const manager = new McpConnectionManager({
    clientFactory: (connection) =>
      new McpRawClient({
        auth: { mode: "none" },
        connectionId: connection.id,
        endpoint: connection.server,
        endpointAuthorizer: permissiveMcpEndpointAuthorizerForTests(),
        protocolFactory: () => protocol,
      }),
  });

  const client = await manager.getReadyClient(connectionId);
  const revision = client.catalog?.revision;
  assert.ok(revision);

  return revision;
}

async function invocationsForStaging(stagingId: string) {
  return db().select().from(mcpInvocation).where(eq(mcpInvocation.stagingId, stagingId));
}

async function seedRecoverableWrite(protocol: FakeProtocol) {
  const userId = await seedUser();
  const connId = await seedConnection(userId);
  const [servedTool] = protocol.tools;
  assert.ok(servedTool, "seed recovery tool missing");
  const remoteName = servedTool.name;
  const revision = await liveRevision(protocol, connId);

  const ref: ExternalToolRef = {
    kind: "mcp",
    connectionId: connId,
    remoteName,
    catalogRevision: revision,
  };

  const argumentsValue = { amount: 4200 };
  const exactInput = stagedCallInput(ref, argumentsValue);
  protocol.behavior = { kind: "throw", error: new Error("connection reset mid-send") };
  const stagingId = await seedStaging(userId, exactInput);

  const first = await brokerWith(protocol).callTool({
    userId,
    stagingId,
    ref,
    arguments: argumentsValue,
  });

  assert.equal(first.status, "ambiguous");

  if (first.status !== "ambiguous") throw new Error("unreachable");
  await db()
    .update(actionStagings)
    .set({ status: "executed", outcome: "unknown" })
    .where(eq(actionStagings.id, stagingId));

  return {
    userId,
    connId,
    stagingId,
    invocationId: first.invocationId,
    ref,
    argumentsValue,
  };
}

async function assertPriorRecoveryBarriersUnchanged(input: {
  invocationId: string;
  stagingId: string;
}): Promise<void> {
  const [prior] = await db()
    .select()
    .from(mcpInvocation)
    .where(eq(mcpInvocation.id, input.invocationId));

  const [staging] = await db()
    .select()
    .from(actionStagings)
    .where(eq(actionStagings.id, input.stagingId));

  const successors = await db()
    .select({ id: mcpInvocation.id })
    .from(mcpInvocation)
    .where(eq(mcpInvocation.successorOf, input.invocationId));

  assert.equal(prior?.resolvedAt, null);
  assert.equal(prior?.effectOutcome, "unknown");
  assert.equal(staging?.outcome, "unknown");
  assert.equal(successors.length, 0);
}

describe("mcp execution broker (DB-backed, offline)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("a reviewed read records a completed invocation without an approval barrier", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("search")]);
    const revision = await liveRevision(protocol, connId);

    // Review `search` as a read so the broker skips the approval barrier.
    await upsertToolPolicy({
      userId,
      connectionId: connId,
      remoteName: "search",
      descriptorHash: descriptorHash(tool("search")),
      riskTier: "low",
      effectClass: "read",
      retryContract: "never",
    });

    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "search",
      catalogRevision: revision,
    };

    const outcome = await broker.callTool({ userId, stagingId, ref, arguments: {} });

    assert.equal(outcome.status, "completed");
    assert.ok(outcome.status === "completed" && outcome.invocationId);
    const [invocation] = await invocationsForStaging(stagingId);

    assert.ok(invocation);
    assert.equal(invocation.id, outcome.invocationId);
    assert.equal(invocation.effectClass, "read");
    assert.equal(invocation.attemptLifecycle, "response_received");
    assert.equal(invocation.effectOutcome, "succeeded");
  });

  // A `read` policy holds only while its reviewed descriptor is still in the current catalog.
  // The guard is the policy join in `resolveMcpToolIdentity` (`invocations.ts`): a stale hash does not join,
  // so the `unknown` default applies. Dropping that join is the mutant this case kills.
  // The broker's own hash check is not exercised here: editing a descriptor also moves the revision.
  test("a stale reviewed hash discards the read policy and takes the effectful path", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const liveDescriptor = tool("search");
    const protocol = new FakeProtocol([liveDescriptor]);
    const revision = await liveRevision(protocol, connId);

    // Reviewed as a read — but against a descriptor the server no longer serves.
    const reviewedDescriptor = {
      ...liveDescriptor,
      description: "What the reviewer approved, before the server changed it",
    } satisfies Tool;

    // Without this, the case degrades into the matching-hash test above, which asserts the opposite.
    assert.notEqual(
      descriptorHash(reviewedDescriptor),
      descriptorHash(liveDescriptor),
      "the fixture is a drift case only if the two descriptors hash differently",
    );
    await upsertToolPolicy({
      userId,
      connectionId: connId,
      remoteName: "search",
      descriptorHash: descriptorHash(reviewedDescriptor),
      riskTier: "low",
      effectClass: "read",
      retryContract: "never",
    });

    const stagingId = await seedStaging(userId);

    const outcome = await brokerWith(protocol).callTool({
      userId,
      stagingId,
      ref: { kind: "mcp", connectionId: connId, remoteName: "search", catalogRevision: revision },
      arguments: {},
    });

    // The exemption is gone: the call is ledgered like any unreviewed effect.
    assert.equal(outcome.status, "completed");
    const [row] = await invocationsForStaging(stagingId);
    assert.ok(row, "a discarded read policy must take the effectful barrier path");
    assert.equal(row.effectClass, "unknown");
    assert.equal(row.policyRevision, null, "no policy applied means no policy recorded");
    assert.equal(
      row.descriptorHash,
      descriptorHash(liveDescriptor),
      "the ledger records the descriptor that was actually called, not the reviewed one",
    );
  });

  test("an unreviewed (unknown) write mints a ledger row and resolves succeeded", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    const revision = await liveRevision(protocol, connId);

    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "create_issue",
      catalogRevision: revision,
    };

    const outcome = await broker.callTool({ userId, stagingId, ref, arguments: { title: "x" } });

    assert.equal(outcome.status, "completed");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectClass, "unknown");
    assert.equal(row?.attemptLifecycle, "response_received");
    assert.equal(row?.effectOutcome, "succeeded");
    assert.ok(row?.resolvedAt);
  });

  test("a tool_error after application stays ambiguous and blocks an ordinary repeat", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    protocol.behavior = { kind: "tool_error" };
    let appliedEffects = 0;
    protocol.beforeReturn = async () => {
      appliedEffects += 1;
    };

    const revision = await liveRevision(protocol, connId);

    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);

    const outcome = await broker.callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "create_issue",
        catalogRevision: revision,
      },
      arguments: { title: "x" },
    });

    assert.equal(outcome.status, "ambiguous");
    assert.equal(appliedEffects, 1, "the provider applied the effect before returning isError");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.retryDisposition, "blocked");
    assert.equal(row?.resolvedAt, null);

    const repeated = await broker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "create_issue",
        catalogRevision: revision,
      },
      arguments: { title: "x" },
    });

    assert.equal(repeated.status, "blocked");
    assert.equal(appliedEffects, 1, "an ordinary model repeat cannot apply the effect again");
  });

  test("a possibly-delivered failure resolves ambiguous and blocks an identical repeat", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    protocol.behavior = { kind: "throw", error: new Error("connection reset mid-send") };
    const revision = await liveRevision(protocol, connId);

    const broker = brokerWith(protocol);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "charge_card",
      catalogRevision: revision,
    };

    const args = { amount: 4200 };

    const first = await broker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(first.status, "ambiguous");

    if (first.status !== "ambiguous") throw new Error("unreachable");
    assert.ok(first.invocationId);

    // The row is unresolved: unknown outcome, blocked disposition, no resolvedAt.
    const [row] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, first.invocationId));

    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.retryDisposition, "blocked");
    assert.equal(row?.resolvedAt, null);

    // An identical proposal (fresh staging row) is refused by the barrier and never reaches the transport.
    const callsBefore = protocol.calls;

    const second = await broker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(second.status, "blocked");

    if (second.status !== "blocked") throw new Error("unreachable");
    assert.equal(second.reason, "ambiguity_barrier");
    assert.equal(second.priorInvocationId, first.invocationId);
    assert.equal(protocol.calls, callsBefore, "the blocked repeat must not be dispatched");
  });

  test("a post-delivery descriptor mismatch stays ambiguous and keeps the barrier", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    protocol.behavior = {
      kind: "throw",
      error: new ProtocolError(-32020, "HEADER_MISMATCH"),
    };
    const revision = await liveRevision(protocol, connId);
    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);

    const outcome = await broker.callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "charge_card",
        catalogRevision: revision,
      },
      arguments: { amount: 4200 },
    });

    assert.equal(outcome.status, "ambiguous");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.retryDisposition, "blocked");
    assert.equal(row?.resolvedAt, null);
    assert.equal(protocol.calls, 1);
  });

  // The broker refuses a stale catalog revision before it mints a reservation.
  // A call rejected before dispatch needs no barrier, so the ledger stays empty (as in the foreign-connection case).
  test("a stale catalog revision is refused pre-dispatch and mints no reservation", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    const revision = await liveRevision(protocol, connId);
    assert.notEqual(revision, STALE_REVISION, "the fixture must actually be a stale revision");

    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);
    const callsBefore = protocol.calls;

    await assert.rejects(
      broker.callTool({
        userId,
        stagingId,
        ref: {
          kind: "mcp",
          connectionId: connId,
          remoteName: "create_issue",
          catalogRevision: STALE_REVISION,
        },
        arguments: {},
      }),
      /catalog changed|refresh/i,
    );

    assert.equal(protocol.calls, callsBefore, "a stale-catalog call must not be dispatched");
    assert.equal(
      (await invocationsForStaging(stagingId)).length,
      0,
      "a call that provably never left the host earns no barrier",
    );
  });

  // A session that expires after `tools/call` went out is a possibly-delivered write.
  // No layer may replay it, and the durable barrier refuses the repeat even from a fresh worker.
  test("a session expiry after dispatch is ambiguous and no reconnect replays it", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    const revision = await liveRevision(protocol, connId);

    // One outbound `tools/call`, then HTTP 404 before a result. The raw client maps this to `session_expired`.
    protocol.behavior = {
      kind: "throw",
      error: new SdkHttpError(
        SdkErrorCode.ClientHttpFailedToOpenStream,
        "session expired mid-call",
        { status: 404 },
      ),
    };

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "charge_card",
      catalogRevision: revision,
    };

    const args = { amount: 4200 };

    const firstBroker = brokerWith(protocol);

    const firstOutcome = await firstBroker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(firstOutcome.status, "ambiguous");

    if (firstOutcome.status !== "ambiguous") throw new Error("unreachable");
    assert.equal(protocol.calls, 1, "exactly one outbound tools/call");

    const [row] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, firstOutcome.invocationId));

    // The lifecycle stops at the delivery boundary, and the row stays unresolved so the barrier holds.
    assert.equal(row?.attemptLifecycle, "delivery_possible");
    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.retryDisposition, "blocked");
    assert.equal(row?.resolvedAt, null);

    // A fresh manager and broker truly reconnect. The fake would now succeed, so the block is the barrier.
    protocol.behavior = { kind: "ok" };
    const reconnectedBroker = brokerWith(protocol);

    const second = await reconnectedBroker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(second.status, "blocked");

    if (second.status !== "blocked") throw new Error("unreachable");
    assert.equal(second.reason, "ambiguity_barrier");
    assert.equal(second.priorInvocationId, firstOutcome.invocationId);
    assert.equal(protocol.calls, 1, "reconnect must not replay a possibly-delivered write");

    // A model proposal cannot authorize the explicit recovery path.
    const stillBlocked = await reconnectedBroker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(stillBlocked.status, "blocked");
    assert.equal(protocol.calls, 1, "a model proposal can never self-authorize a successor");
  });

  test("an explicit recovery successor sends once and a repeated post only reads it", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    const revision = await liveRevision(protocol, connId);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "charge_card",
      catalogRevision: revision,
    };

    const args = { amount: 4200 };
    const exactInput = stagedCallInput(ref, args);
    protocol.behavior = {
      kind: "throw",
      error: new SdkHttpError(
        SdkErrorCode.ClientHttpFailedToOpenStream,
        "session expired mid-call",
        { status: 404 },
      ),
    };
    const firstBroker = brokerWith(protocol);
    const stagingId = await seedStaging(userId, exactInput);
    const first = await firstBroker.callTool({ userId, stagingId, ref, arguments: args });
    assert.equal(first.status, "ambiguous");

    if (first.status !== "ambiguous") throw new Error("unreachable");
    await db()
      .update(actionStagings)
      .set({ status: "executed", outcome: "unknown" })
      .where(eq(actionStagings.id, stagingId));

    protocol.behavior = { kind: "ok" };
    const recoveryBroker = brokerWith(protocol);
    _setMcpExecutionBrokerForTests(recoveryBroker);

    try {
      const recovered = await retryMcpRecoveryOperation({
        userId,
        invocationId: first.invocationId,
      });

      assert.equal(recovered.status, "completed");
      assert.ok(recovered.successorInvocationId);
      assert.equal(protocol.calls, 2, "the user-authorized successor sends once");

      const repeated = await retryMcpRecoveryOperation({
        userId,
        invocationId: first.invocationId,
      });

      assert.equal(repeated.status, "blocked");
      assert.equal(repeated.successorInvocationId, recovered.successorInvocationId);
      assert.equal(protocol.calls, 2, "a repeated HTTP post cannot send the successor again");

      const [prior] = await db()
        .select()
        .from(mcpInvocation)
        .where(eq(mcpInvocation.id, first.invocationId));

      const [successor] = await db()
        .select()
        .from(mcpInvocation)
        .where(eq(mcpInvocation.id, recovered.successorInvocationId!));

      const [successorStaging] = await db()
        .select()
        .from(actionStagings)
        .where(eq(actionStagings.id, successor?.stagingId ?? "missing"));

      assert.equal(prior?.resolutionReason, "superseded_by_user_successor");
      assert.equal(successor?.successorOf, prior?.id);
      assert.equal(successor?.effectOutcome, "succeeded");
      assert.equal(successorStaging?.outcome, "succeeded");
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }
  });

  test("a recovery successor tool_error stays ambiguous after the provider applies an effect", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "tool_error" };
    let appliedEffects = 0;
    protocol.beforeReturn = async () => {
      appliedEffects += 1;
    };

    _setMcpExecutionBrokerForTests(brokerWith(protocol));

    try {
      const recovered = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(recovered.status, "ambiguous");
      assert.equal(appliedEffects, 1);

      const [successor] = await db()
        .select()
        .from(mcpInvocation)
        .where(eq(mcpInvocation.id, recovered.successorInvocationId!));

      assert.equal(successor?.attemptLifecycle, "response_received");
      assert.equal(successor?.effectOutcome, "unknown");
      assert.equal(successor?.retryDisposition, "blocked");
      assert.equal(successor?.resolvedAt, null);

      const repeated = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(repeated.status, "blocked");
      assert.equal(appliedEffects, 1, "the ambiguous successor cannot be sent again");
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }
  });

  test("a pre-claim failure stays visible and only a fresh explicit post resumes it", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    const callsAfterAmbiguousAttempt = protocol.calls;

    protocol.behavior = { kind: "ok" };
    protocol.connectError = new Error("recovery connect failed before claim");
    _setMcpExecutionBrokerForTests(brokerWith(protocol));

    try {
      await assert.rejects(
        retryMcpRecoveryOperation({
          userId: seeded.userId,
          invocationId: seeded.invocationId,
        }),
        /recovery connect failed before claim/,
      );
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    assert.equal(
      protocol.calls,
      callsAfterAmbiguousAttempt,
      "a failure before the prepared claim cannot send",
    );

    const operationsAfterFailure = (await listMcpRecoveryOperations({ userId: seeded.userId }))
      .operations;

    assert.equal(operationsAfterFailure.length, 1);
    const prepared = operationsAfterFailure[0];
    assert.ok(prepared);
    assert.equal(prepared.successorOf, seeded.invocationId);
    assert.equal(prepared.attemptLifecycle, "prepared");
    assert.equal(prepared.effectOutcome, null);
    assert.equal(prepared.deliveryPossibleAt, null);

    const boot = await reconcileInflightInvocations(seeded.userId);
    assert.equal(boot.abandoned, 0, "boot keeps the user-authorized reservation");
    assert.equal(
      protocol.calls,
      callsAfterAmbiguousAttempt,
      "boot reconciliation never delivers a successor",
    );

    protocol.connectError = undefined;
    const refreshedRevision = await liveRevision(protocol, seeded.connId);
    assert.equal(refreshedRevision, seeded.ref.catalogRevision);
    assert.equal(
      protocol.calls,
      callsAfterAmbiguousAttempt,
      "catalog reconnect is a read and does not deliver the prepared successor",
    );
    const reconnectedBroker = brokerWith(protocol);
    assert.equal(
      protocol.calls,
      callsAfterAmbiguousAttempt,
      "constructing a reconnected broker does not deliver",
    );
    _setMcpExecutionBrokerForTests(reconnectedBroker);

    try {
      const resumed = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: prepared.invocationId,
      });

      assert.equal(resumed.status, "completed");
      assert.equal(resumed.invocationId, seeded.invocationId);
      assert.equal(resumed.successorInvocationId, prepared.invocationId);
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    assert.equal(protocol.calls, callsAfterAmbiguousAttempt + 1, "the fresh post sends once");
    assert.equal((await listMcpRecoveryOperations({ userId: seeded.userId })).operations.length, 0);
  });

  test("a concurrent catalog publication is observed before either prior barrier moves", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "ok" };
    _setMcpExecutionBrokerForTests(brokerWith(protocol));
    let retryPromise: ReturnType<typeof retryMcpRecoveryOperation> | undefined;

    try {
      await db().transaction(async (tx) => {
        await tx
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(eq(mcpConnections.id, seeded.connId))
          .for("update");
        retryPromise = claimExpectedRejection(
          retryMcpRecoveryOperation({
            userId: seeded.userId,
            invocationId: seeded.invocationId,
          }),
        );
        const changedTool = { ...tool("charge_card"), description: "changed authority" };
        await publishCatalogRevision(
          {
            connectionId: seeded.connId,
            revisionHash: `sha256:${randomUUID()}`,
            descriptors: [changedTool],
          },
          tx,
        );
      });
      assert.ok(retryPromise);
      await assert.rejects(retryPromise, /MCP tool changed/);
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    await assertPriorRecoveryBarriersUnchanged(seeded);
    assert.equal(protocol.calls, 1, "catalog drift is rejected before a successor send");
  });

  test("a concurrent first policy publication is observed before either prior barrier moves", async () => {
    const servedTool = tool("charge_card");
    const protocol = new FakeProtocol([servedTool]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "ok" };
    _setMcpExecutionBrokerForTests(brokerWith(protocol));
    let retryPromise: ReturnType<typeof retryMcpRecoveryOperation> | undefined;

    try {
      await db().transaction(async (tx) => {
        await tx
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(eq(mcpConnections.id, seeded.connId))
          .for("update");
        retryPromise = claimExpectedRejection(
          retryMcpRecoveryOperation({
            userId: seeded.userId,
            invocationId: seeded.invocationId,
          }),
        );
        await upsertToolPolicy(
          {
            userId: seeded.userId,
            connectionId: seeded.connId,
            remoteName: "charge_card",
            descriptorHash: descriptorHash(servedTool),
            policyRevision: 1,
            riskTier: "high",
            effectClass: "write",
            retryContract: "never",
          },
          tx,
        );
      });
      assert.ok(retryPromise);
      await assert.rejects(retryPromise, /MCP tool changed/);
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    await assertPriorRecoveryBarriersUnchanged(seeded);
    assert.equal(protocol.calls, 1, "policy drift is rejected before a successor send");
  });

  test("a concurrent ownership transfer is observed before either prior barrier moves", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    const attackerId = await seedUser();

    const attackerConnection = await ensureConnection({
      userId: attackerId,
      label: "Attacker MCP",
      instanceKey: "default",
      canonicalResource: `mcp://attacker/${randomUUID()}`,
      endpoint: new URL("https://attacker.example.test/mcp"),
    });

    protocol.behavior = { kind: "ok" };
    _setMcpExecutionBrokerForTests(brokerWith(protocol));
    let retryPromise: ReturnType<typeof retryMcpRecoveryOperation> | undefined;

    try {
      await db().transaction(async (tx) => {
        await tx
          .select({ id: mcpConnections.id })
          .from(mcpConnections)
          .where(eq(mcpConnections.id, seeded.connId))
          .for("update");
        retryPromise = claimExpectedRejection(
          retryMcpRecoveryOperation({
            userId: seeded.userId,
            invocationId: seeded.invocationId,
          }),
        );
        // The attacker already holds `default`, and `(user_id, server_id, instance_key)` is unique.
        await tx
          .update(mcpConnections)
          .set({
            userId: attackerId,
            serverId: attackerConnection.serverId,
            instanceKey: "transferred",
          })
          .where(eq(mcpConnections.id, seeded.connId));
      });
      assert.ok(retryPromise);
      await assert.rejects(retryPromise, /MCP recovery operation not found/);
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    await assertPriorRecoveryBarriersUnchanged(seeded);
    assert.equal(protocol.calls, 1, "ownership drift is rejected before a successor send");
  });

  test("successor settlement cannot overwrite an already-settled state", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "ok" };
    protocol.beforeReturn = async () => {
      const [successor] = await db()
        .select()
        .from(mcpInvocation)
        .where(eq(mcpInvocation.successorOf, seeded.invocationId));

      assert.ok(successor);
      const stagingId = successor.stagingId;
      assert.ok(stagingId);
      const now = new Date();
      await db().transaction(async (tx) => {
        await tx
          .update(mcpInvocation)
          .set({
            attemptLifecycle: "response_received",
            effectOutcome: "succeeded",
            retryDisposition: "safe",
            resolvedAt: now,
            resolutionReason: "concurrent_settlement",
          })
          .where(eq(mcpInvocation.id, successor.id));
        await tx
          .update(actionStagings)
          .set({ status: "executed", outcome: "succeeded", executedAt: now })
          .where(eq(actionStagings.id, stagingId));
      });
    };

    _setMcpExecutionBrokerForTests(brokerWith(protocol));

    try {
      const result = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(result.status, "ambiguous");
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    const [successor] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.successorOf, seeded.invocationId));

    assert.equal(successor?.effectOutcome, "succeeded");
    assert.equal(successor?.resolutionReason, "concurrent_settlement");
    assert.equal(protocol.calls, 2, "the guarded failure cannot cause a second send");
  });

  test("a post-response settlement failure is immediately visible without another send", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "ok" };
    protocol.beforeReturn = async () => {
      const [successor] = await db()
        .select({ stagingId: mcpInvocation.stagingId })
        .from(mcpInvocation)
        .where(eq(mcpInvocation.successorOf, seeded.invocationId));

      assert.ok(successor);
      assert.ok(successor.stagingId);
      // Fail the first settlement's staging guard after the provider returned.
      // The local fallback must align this split state without calling the provider again.
      await db()
        .update(actionStagings)
        .set({ outcome: "planned" })
        .where(eq(actionStagings.id, successor.stagingId));
    };

    _setMcpExecutionBrokerForTests(brokerWith(protocol));

    try {
      const result = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(result.status, "ambiguous");
      assert.equal(protocol.calls, 2, "the authorized successor was sent exactly once");

      const operations = (await listMcpRecoveryOperations({ userId: seeded.userId })).operations;
      assert.equal(operations.length, 1, "the unsettled response is visible before boot");
      const visible = operations[0];
      assert.equal(visible?.invocationId, result.successorInvocationId);
      assert.equal(visible?.attemptLifecycle, "response_received");
      assert.equal(visible?.effectOutcome, "unknown");
      assert.equal(visible?.retryDisposition, "blocked");

      const repeated = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(repeated.status, "blocked");
      assert.equal(protocol.calls, 2, "recovery visibility does not create a resend");
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }
  });

  test("normal provider effect and settlement failure stay recoverable through dispatcher and boot", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    const revision = await liveRevision(protocol, connId);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "create_issue",
      catalogRevision: revision,
    };

    const stagingId = await seedStaging(userId, stagedCallInput(ref, { title: "one" }));
    let appliedEffects = 0;
    protocol.beforeReturn = async () => {
      appliedEffects += 1;
      await db()
        .update(actionStagings)
        .set({ outcome: "planned" })
        .where(eq(actionStagings.id, stagingId));
    };

    const broker = brokerWith(protocol);

    const outcome = await broker.callTool({
      userId,
      stagingId,
      ref,
      arguments: { title: "one" },
    });

    assert.equal(outcome.status, "ambiguous");
    assert.equal(appliedEffects, 1);

    // This is the generic dispatcher's terminal commit after the broker returns.
    await db()
      .update(actionStagings)
      .set({ status: "executed", outcome: "unknown" })
      .where(eq(actionStagings.id, stagingId));
    const visibleWithoutBoot = (await listMcpRecoveryOperations({ userId })).operations;
    assert.equal(visibleWithoutBoot.length, 1);
    assert.equal(visibleWithoutBoot[0]?.invocationId, outcome.invocationId);

    const boot = await reconcileInflightInvocations(userId);
    assert.equal(boot.markedUnknown, 0);
    assert.equal(boot.alignedStagingBarriers, 0);

    const resolved = await resolveMcpRecoveryOperation({
      userId,
      invocationId: outcome.invocationId!,
      decision: "confirmed_not_applied",
    });

    assert.equal(resolved.status, "resolved");
    assert.equal(protocol.calls, 1, "repair, list, boot, and resolution never resend");
  });

  test("a successor provider throw plus settlement failure is visible and never resent", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "throw", error: new Error("reset after provider effect") };
    protocol.beforeReturn = async () => {
      const [successor] = await db()
        .select({ stagingId: mcpInvocation.stagingId })
        .from(mcpInvocation)
        .where(eq(mcpInvocation.successorOf, seeded.invocationId));

      assert.ok(successor);
      assert.ok(successor.stagingId);
      await db()
        .update(actionStagings)
        .set({ outcome: "planned" })
        .where(eq(actionStagings.id, successor.stagingId));
    };

    _setMcpExecutionBrokerForTests(brokerWith(protocol));

    try {
      const result = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(result.status, "ambiguous");
      const operations = (await listMcpRecoveryOperations({ userId: seeded.userId })).operations;
      assert.equal(operations.length, 1);
      assert.equal(operations[0]?.invocationId, result.successorInvocationId);

      const repeated = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(repeated.status, "blocked");
      assert.equal(protocol.calls, 2, "the possibly-delivered successor is not resent");
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }
  });

  test("a failed local settlement repair is counted by the pure read and retried by the drain", async () => {
    const protocol = new FakeProtocol([tool("charge_card")]);
    const seeded = await seedRecoverableWrite(protocol);
    protocol.behavior = { kind: "ok" };
    let successorStagingId = "";
    protocol.beforeReturn = async () => {
      const [successor] = await db()
        .select({ stagingId: mcpInvocation.stagingId })
        .from(mcpInvocation)
        .where(eq(mcpInvocation.successorOf, seeded.invocationId));

      assert.ok(successor);
      assert.ok(successor.stagingId);
      successorStagingId = successor.stagingId;
      // Neither the aggregate settle nor the incomplete mark accepts `refused`, so the first repair fails.
      await db()
        .update(actionStagings)
        .set({ status: "failed", outcome: "refused" })
        .where(eq(actionStagings.id, successor.stagingId));
    };

    const broker = brokerWith(protocol);
    _setMcpExecutionBrokerForTests(broker);

    try {
      const result = await retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      });

      assert.equal(result.status, "ambiguous");
      assert.ok(successorStagingId);

      const callsBeforeGet = protocol.calls;
      const counted = await listMcpRecoveryOperations({ userId: seeded.userId });
      assert.deepEqual(counted.operations, [], "an unsettled successor is not projected");
      assert.equal(counted.awaitingRepair, 1, "the read reports it instead");
      assert.equal(protocol.calls, callsBeforeGet, "the read never calls a provider");

      // The dispatcher-shaped terminal value the repair accepts.
      await db()
        .update(actionStagings)
        .set({ status: "failed", outcome: "failed" })
        .where(eq(actionStagings.id, successorStagingId));
      const drained = await broker.drainPendingSettlementRepairs();
      assert.deepEqual(drained, { repaired: 1, remaining: 0 });

      const page = await listMcpRecoveryOperations({ userId: seeded.userId });
      assert.equal(page.awaitingRepair, 0);
      assert.equal(page.operations[0]?.invocationId, result.successorInvocationId);
      assert.equal(protocol.calls, callsBeforeGet, "repair is local only");
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }
  });

  test("recovery descriptor drift fails before either prior barrier changes", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    const revision = await liveRevision(protocol, connId);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "charge_card",
      catalogRevision: revision,
    };

    const exactInput = stagedCallInput(ref, { amount: 4200 });
    protocol.behavior = { kind: "throw", error: new Error("connection reset mid-send") };
    const stagingId = await seedStaging(userId, exactInput);

    const first = await brokerWith(protocol).callTool({
      userId,
      stagingId,
      ref,
      arguments: exactInput.arguments,
    });

    assert.equal(first.status, "ambiguous");

    if (first.status !== "ambiguous") throw new Error("unreachable");
    await db()
      .update(actionStagings)
      .set({ status: "executed", outcome: "unknown" })
      .where(eq(actionStagings.id, stagingId));
    await db()
      .update(mcpInvocation)
      .set({ descriptorHash: "sha256:drift" })
      .where(eq(mcpInvocation.id, first.invocationId));

    protocol.behavior = { kind: "ok" };
    _setMcpExecutionBrokerForTests(brokerWith(protocol));

    try {
      await assert.rejects(
        retryMcpRecoveryOperation({ userId, invocationId: first.invocationId }),
        /MCP tool changed/,
      );
    } finally {
      _setMcpExecutionBrokerForTests(undefined);
    }

    const [prior] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, first.invocationId));

    const [staging] = await db()
      .select()
      .from(actionStagings)
      .where(eq(actionStagings.id, stagingId));

    const successors = await db()
      .select({ id: mcpInvocation.id })
      .from(mcpInvocation)
      .where(eq(mcpInvocation.successorOf, first.invocationId));

    assert.equal(prior?.resolvedAt, null);
    assert.equal(staging?.outcome, "unknown");
    assert.equal(successors.length, 0);
    assert.equal(protocol.calls, 1);
  });

  // Malformed output after possible delivery is not proven non-delivery, so an effectful call resolves ambiguous.
  test("invalid output after possible delivery is ambiguous for an effectful call", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);

    const declaredOutput = {
      name: "create_issue",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    } satisfies Tool;

    const protocol = new FakeProtocol([declaredOutput]);
    // Output that violates the declared schema: the raw client throws `invalid_output` after delivery.
    protocol.behavior = {
      kind: "throw",
      error: new Error("unused — overridden below"),
    };
    protocol.callTool = async () => {
      protocol.calls += 1;

      return { content: [{ type: "text", text: "ok" }], structuredContent: { wrong: true } };
    };

    const revision = await liveRevision(protocol, connId);

    const broker2 = brokerWith(protocol);
    const stagingId = await seedStaging(userId);

    const outcome = await broker2.callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "create_issue",
        catalogRevision: revision,
      },
      arguments: {},
    });

    assert.equal(outcome.status, "ambiguous");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.retryDisposition, "blocked");
    assert.equal(row?.resolvedAt, null);
    // A response arrived, so provenance is persisted even though the outcome is ambiguous.
    // `outputSchemaValidated: false` records why it failed.
    assert.equal(row?.attemptLifecycle, "response_received");
    assert.deepEqual(row?.resultProvenance, {
      isError: false,
      hasStructuredContent: true,
      outputSchemaValidated: false,
      contentBlockCount: 1,
      contentKinds: { text: 1 },
      truncated: false,
    });
  });

  // The barrier keys on the reviewed effect class, not the risk tier: a low-risk write still gets it.
  test("a low-risk reviewed write still receives ambiguous-write protection", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("send_message")]);
    const revision = await liveRevision(protocol, connId);

    await upsertToolPolicy({
      userId,
      connectionId: connId,
      remoteName: "send_message",
      descriptorHash: descriptorHash(tool("send_message")),
      riskTier: "low",
      effectClass: "write",
      retryContract: "never",
    });

    protocol.behavior = { kind: "throw", error: new Error("reset before ack") };
    const broker3 = brokerWith(protocol);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "send_message",
      catalogRevision: revision,
    };

    const args = { text: "hi" };

    const outcome = await broker3.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(outcome.status, "ambiguous");

    const callsBefore = protocol.calls;

    const repeat = await broker3.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });

    assert.equal(repeat.status, "blocked");
    assert.equal(protocol.calls, callsBefore, "a low-risk write repeat is still barred");
  });

  // The broker persists a payload-free provenance envelope whenever a response arrives, on success and on tool_error.
  test("a received response persists the result-provenance envelope on the ledger row", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);

    const okProtocol = new FakeProtocol([tool("create_issue")]);
    const okRevision = await liveRevision(okProtocol, connId);
    const okStaging = await seedStaging(userId);

    const okOutcome = await brokerWith(okProtocol).callTool({
      userId,
      stagingId: okStaging,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "create_issue",
        catalogRevision: okRevision,
      },
      arguments: { title: "x" },
    });

    assert.equal(okOutcome.status, "completed");
    const [okRow] = await invocationsForStaging(okStaging);
    assert.deepEqual(okRow?.resultProvenance, {
      isError: false,
      hasStructuredContent: false,
      outputSchemaValidated: false,
      contentBlockCount: 1,
      contentKinds: { text: 1 },
      truncated: false,
    });

    const errProtocol = new FakeProtocol([tool("create_issue")]);
    errProtocol.behavior = { kind: "tool_error" };
    const errRevision = await liveRevision(errProtocol, connId);
    const errStaging = await seedStaging(userId);

    const errOutcome = await brokerWith(errProtocol).callTool({
      userId,
      stagingId: errStaging,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "create_issue",
        catalogRevision: errRevision,
      },
      arguments: { title: "y" },
    });

    assert.equal(errOutcome.status, "ambiguous");
    const [errRow] = await invocationsForStaging(errStaging);
    assert.equal(errRow?.resultProvenance?.isError, true);
    assert.deepEqual(errRow?.resultProvenance?.contentKinds, { text: 1 });
  });

  // No response means no provenance: the column stays NULL and no model projection is stored.
  test("a transport failure with no response leaves the result-provenance envelope null", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    protocol.behavior = { kind: "throw", error: new Error("reset mid-send") };
    const revision = await liveRevision(protocol, connId);

    const stagingId = await seedStaging(userId);

    const outcome = await brokerWith(protocol).callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "charge_card",
        catalogRevision: revision,
      },
      arguments: { amount: 1 },
    });

    assert.equal(outcome.status, "ambiguous");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.attemptLifecycle, "delivery_possible");
    assert.equal(row?.resultProvenance, null);
  });

  // Ownership, as in `listMcpToolsLocal`: a foreign `connectionId` reads as "not connected",
  // and never reaches the network or mints a ledger row.
  test("a call against a connection owned by another user is refused pre-dispatch", async () => {
    const owner = await seedUser();
    const connId = await seedConnection(owner);
    const protocol = new FakeProtocol([tool("create_issue")]);
    const revision = await liveRevision(protocol, connId);

    const attacker = await seedUser();
    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(attacker);

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: connId,
      remoteName: "create_issue",
      catalogRevision: revision,
    };

    const callsBefore = protocol.calls;

    await assert.rejects(
      broker.callTool({ userId: attacker, stagingId, ref, arguments: { title: "x" } }),
      (err: unknown) => err instanceof McpClientError && err.code === "not_connected",
    );

    // Nothing was dispatched and no ledger row was minted under either user.
    assert.equal(protocol.calls, callsBefore, "a foreign connection never reaches the network");
    assert.equal((await invocationsForStaging(stagingId)).length, 0);
  });

  // The ledger copies `run_id` / `step_id` / `tool_call_id` from the staging row at mint.
  // The two phase timestamps are stamped in order. Observability only; the barrier keys on `argsHash`.
  test("correlation ids are copied from the staging row and phase timestamps persisted", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    const revision = await liveRevision(protocol, connId);

    const stagingId = await seedStaging(userId);

    const [staging] = await db()
      .select({
        runId: actionStagings.runId,
        stepId: actionStagings.stepId,
        toolCallId: actionStagings.toolCallId,
      })
      .from(actionStagings)
      .where(eq(actionStagings.id, stagingId));

    assert.ok(staging, "seeded staging row");

    const outcome = await brokerWith(protocol).callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "create_issue",
        catalogRevision: revision,
      },
      arguments: { title: "x" },
    });

    assert.equal(outcome.status, "completed");

    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.traceId, staging.runId);
    assert.equal(row?.stepId, staging.stepId);
    assert.equal(row?.toolCallId, staging.toolCallId);
    // Both phases were reached on a clean success, in order.
    assert.ok(row?.deliveryPossibleAt, "delivery boundary stamped");
    assert.ok(row?.responseReceivedAt, "response arrival stamped");
    assert.ok(
      row.deliveryPossibleAt.getTime() <= row.responseReceivedAt.getTime(),
      "delivery precedes response",
    );
  });

  // With no response, `responseReceivedAt` stays null even though delivery was possible.
  test("responseReceivedAt stays null when no response arrives", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    protocol.behavior = { kind: "throw", error: new Error("reset mid-send") };
    const revision = await liveRevision(protocol, connId);

    const stagingId = await seedStaging(userId);

    const outcome = await brokerWith(protocol).callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "charge_card",
        catalogRevision: revision,
      },
      arguments: { amount: 1 },
    });

    assert.equal(outcome.status, "ambiguous");
    const [row] = await invocationsForStaging(stagingId);
    assert.ok(row?.deliveryPossibleAt, "the delivery boundary was still crossed");
    assert.equal(row?.responseReceivedAt, null, "no response boundary was crossed");
  });

  // An ambiguous attempt must be reconstructable without a credential or a full payload.
  // Error text with secrets and a huge body lands redacted and bounded; raw arguments are only hashed.
  test("secrets and full payloads never enter the ledger row", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    const secretToken = "sk-supersecrettoken1234567890";
    const urlPassword = "urlpw9876543210";
    const rawErrorBody = "Z".repeat(3000);
    protocol.behavior = {
      kind: "throw",
      error: new Error(
        `upstream 500 Authorization: Bearer ${secretToken} ` +
          `endpoint https://svc:${urlPassword}@mcp.example.test/mcp body=${rawErrorBody}`,
      ),
    };
    const revision = await liveRevision(protocol, connId);

    const secretArg = "topsecretargvalue-should-never-persist";
    const stagingId = await seedStaging(userId);

    const outcome = await brokerWith(protocol).callTool({
      userId,
      stagingId,
      ref: {
        kind: "mcp",
        connectionId: connId,
        remoteName: "charge_card",
        catalogRevision: revision,
      },
      arguments: { title: secretArg, amount: 4200 },
    });

    assert.equal(outcome.status, "ambiguous");

    const [row] = await invocationsForStaging(stagingId);
    assert.ok(row?.lastError, "the ambiguous outcome records a bounded error");
    // Secrets stripped.
    assert.ok(!row.lastError.includes(secretToken), "bearer token must not persist");
    assert.ok(!row.lastError.includes(urlPassword), "URL-embedded credential must not persist");
    // Bounded (the 3000-char body cannot land whole).
    assert.ok(!row.lastError.includes(rawErrorBody), "the raw body must be truncated");
    assert.ok(row.lastError.length < 600, "the error is bounded well under the raw length");
    // The raw arguments are hashed, never stored: no column on the row holds them.
    assert.ok(
      !JSON.stringify(row).includes(secretArg),
      "no ledger column may hold the raw argument payload",
    );
  });
});
