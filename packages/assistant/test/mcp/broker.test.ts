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
import {
  createNamedConnection,
  publishCatalogRevision,
} from "../../src/connections/mcp/persistence";
import {
  reconcileInflightInvocations,
  upsertToolPolicy,
} from "../../src/tool-runtime/mcp/invocations";
import {
  listMcpRecoveryOperations,
  retryMcpRecoveryOperation,
} from "../../src/tool-runtime/mcp/recovery";
import { _setMcpExecutionBrokerForTests } from "../../src/tool-runtime/mcp/runtime";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed offline tests for the execution broker (PRD #540). A real
 * `McpRawClient` is wired to a controllable FAKE `McpProtocolClient`, so the full
 * connect → refresh → ledger → call path runs with no socket. Opt-in on
 * `DATABASE_URL`, mirroring the other MCP tests.
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

// Permissive schema on purpose: these tests exercise ledger/barrier semantics,
// not the raw client's exact-schema validation (covered by client tests).
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
      // #559a: the ledger's NOT NULL effect identity and canonical request hash.
      effectKey: `eff:${run.id}:${toolCallId}`,
      attemptKey: `eff:${run.id}:${toolCallId}:1`,
      requestHash: `req_seed_${randomUUID()}`,
      requiresApproval: true,
    });
  return stagingId;
}

async function seedConnection(userId: string): Promise<string> {
  const conn = await createNamedConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpoint: new URL("https://mcp.example.test/mcp"),
  });
  return conn.id;
}

function brokerWith(protocol: FakeProtocol): McpExecutionBroker {
  const manager = new McpConnectionManager({
    clientFactory: (connection) =>
      new McpRawClient({
        connectionId: connection.id,
        endpoint: new URL(connection.server.endpointUrl),
        endpointAuthorization: { authorize: async (endpoint) => new URL(endpoint.href) },
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
        connectionId: connection.id,
        endpoint: new URL(connection.server.endpointUrl),
        endpointAuthorization: { authorize: async (endpoint) => new URL(endpoint.href) },
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
  const exactInput = { ...ref, arguments: argumentsValue };
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

  test("a reviewed read bypasses the ledger entirely", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("search")]);
    const revision = await liveRevision(protocol, connId);

    // Review `search` as a read so the broker skips the barrier/ledger.
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
    assert.equal(outcome.status === "completed" && outcome.invocationId, null);
    assert.equal((await invocationsForStaging(stagingId)).length, 0);
  });

  // The reviewed-read fast path above is an exemption from the ledger, and this
  // is the guard on it: a `read` policy is honored only while the descriptor it
  // was reviewed against is still the one in the current catalog. A server that
  // quietly redefines a tool cannot keep an exemption granted for other behavior.
  //
  // The guard is the POLICY JOIN in `resolveMcpToolIdentity` (`persistence.ts`),
  // which matches `mcp_tool_policy.descriptor_hash` against the hash the current
  // catalog revision stores for that tool name. A stale reviewed hash simply does
  // not join, so no policy is authorized and the conservative `unknown` default
  // applies. Dropping that one join condition is the mutant this case kills.
  //
  // The broker's own `hash === identity.descriptorHash` check is a second gate on
  // the same question, and it is NOT what this case exercises: removing it leaves
  // this test green. It can only fire on a catalog row whose stored descriptor
  // hashes disagree with its own revision hash, because a revision is
  // `sha256Canonical(sortedTools)` over every descriptor (`client.ts`) — so
  // editing a descriptor always moves the revision too, and the broker's
  // catalog-revision check rejects that call earlier. Reach the reachable half:
  // a policy row carrying an earlier review's hash, selected at the CURRENT
  // revision.
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
    // Without this the case would silently degrade into the matching-hash test
    // above, which asserts the OPPOSITE outcome and would still pass.
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

    // An identical proposal (fresh staging row) is refused by the barrier and
    // never reaches the transport again.
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

  // A stale catalog revision is refused by the BROKER, before the reservation is
  // minted. The barrier exists to stop a repeat of a write that may have reached
  // the remote application, so a call rejected before dispatch needs none — the
  // same rule the foreign-connection case below proves for ownership. Read the
  // pair together: this is the second of the two pre-dispatch refusals, and both
  // must leave the ledger empty.
  //
  // This check sat inside the raw client until it moved into the broker, which is
  // why an earlier version of this case expected a minted-then-resolved row. That
  // row recorded a call that provably never happened.
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

  // Reconnect/session-expiry regression (issue #540 VS Code findings): a session
  // that expires AFTER the outbound `tools/call` was observed is a possibly-
  // delivered write. No layer — raw client, SDK, session-refresh, connection
  // manager, or broker — may transparently replay it. The barrier is durable, so
  // even a fresh worker (new manager → real reconnect) must refuse the repeat.
  test("a session expiry after dispatch is ambiguous and no reconnect replays it", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("charge_card")]);
    const revision = await liveRevision(protocol, connId);

    // The server observes exactly one outbound `tools/call`, then the transport
    // reports a session expiry (HTTP 404) before Alfred receives a trustworthy
    // result — the raw client maps this to `session_expired`.
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
    // The lifecycle never advanced past the delivery boundary, and the row stays
    // unresolved so the barrier keeps rejecting an identical repeat.
    assert.equal(row?.attemptLifecycle, "delivery_possible");
    assert.equal(row?.effectOutcome, "unknown");
    assert.equal(row?.retryDisposition, "blocked");
    assert.equal(row?.resolvedAt, null);

    // Reconnect: a brand-new manager/broker (as a cold worker would build) truly
    // reconnects the client. Flip the fake so a hypothetical replay WOULD succeed —
    // proving the block is the durable barrier, not a broken transport.
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
    const exactInput = { ...ref, arguments: args };
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
    const operationsAfterFailure = await listMcpRecoveryOperations(seeded.userId);
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
    assert.equal((await listMcpRecoveryOperations(seeded.userId)).length, 0);
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
        retryPromise = retryMcpRecoveryOperation({
          userId: seeded.userId,
          invocationId: seeded.invocationId,
        });
        const changedTool = { ...tool("charge_card"), description: "changed authority" };
        await publishCatalogRevision(
          {
            connectionId: seeded.connId,
            revisionHash: `sha256:${randomUUID()}`,
            descriptors: [changedTool],
            descriptorHashes: { charge_card: descriptorHash(changedTool) },
            toolCount: 1,
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
        retryPromise = retryMcpRecoveryOperation({
          userId: seeded.userId,
          invocationId: seeded.invocationId,
        });
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
    const attackerConnection = await createNamedConnection({
      userId: attackerId,
      label: "Attacker MCP",
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
        retryPromise = retryMcpRecoveryOperation({
          userId: seeded.userId,
          invocationId: seeded.invocationId,
        });
        await tx
          .update(mcpConnections)
          .set({ userId: attackerId, serverId: attackerConnection.serverId })
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
          .where(eq(actionStagings.id, successor.stagingId));
      });
    };
    _setMcpExecutionBrokerForTests(brokerWith(protocol));
    try {
      await assert.rejects(
        retryMcpRecoveryOperation({
          userId: seeded.userId,
          invocationId: seeded.invocationId,
        }),
        /settleReservedMcpSuccessor guarded invocation/,
      );
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
      // Force the first settlement transaction's staging guard to fail after
      // the provider has returned. The broker's local fallback must align this
      // split state without calling the provider again.
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

      const operations = await listMcpRecoveryOperations(seeded.userId);
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
    const exactInput = { ...ref, arguments: { amount: 4200 } };
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

  // Invalid/malformed output after possible delivery is NOT a proven non-delivery:
  // the write may have applied, so an effectful call resolves ambiguous/blocked
  // (issue #540 clarification #2 — boundary-based, not timeout-specific).
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
    // A structured result that violates the declared output schema → the raw
    // client throws `invalid_output` AFTER the call was delivered.
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
    // A response DID cross the wire, so provenance is persisted even though the
    // outcome is ambiguous (#541): the lifecycle advances to `response_received`
    // and the census records `outputSchemaValidated: false` — the very fact that
    // explains the failure — rather than being lost to an error string.
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

  // Ambiguous-write protection keys on the reviewed EFFECT CLASS, not the approval
  // risk tier: a write downgraded to low risk still gets barrier protection
  // (issue #540 clarification #3).
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

  // #541: the broker persists a payload-free result-provenance envelope onto the
  // ledger row, separately from the sanitized model projection, whenever a
  // response is received — for a clean success AND an ambiguous tool_error.
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

  // A transport failure with NO response received has no result to record: the
  // provenance column stays NULL and the lifecycle never advances past the
  // delivery boundary. (Contrast the invalid_output case above, where a response
  // DID arrive and provenance is persisted despite the ambiguous outcome.) The
  // durable model projection is absent too — nothing to flatten to prose here.
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

  // Ownership is enforced at the broker's boundary, mirroring the read half
  // (`listMcpToolsLocal`): a caller may only drive a connection they own. A
  // foreign `connectionId` reads as "not connected" and never reaches the
  // network or mints a ledger row.
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

  // #541 part 2: the ledger's correlation breadcrumbs are a copy of the authorizing
  // staging row's `run_id` / `step_id` / `tool_call_id`, sourced at mint (never
  // threaded from a ctx that could drift). The two attempt-phase timestamps are
  // stamped in lifecycle order — distinct from the row's `createdAt` (reservation)
  // and `resolvedAt` (terminal). Observability only; the barrier keys on `argsHash`.
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

  // A transport failure with no response never crosses the response boundary, so
  // `responseReceivedAt` stays null even though delivery was possible.
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

  // #541 part 2: the ledger must persist enough to reconstruct an ambiguous
  // attempt WITHOUT ever storing a credential or a full payload. A possibly-
  // delivered failure whose error text carries a bearer token, URL-embedded
  // credentials, and a huge body lands on the row bounded + redacted; and the raw
  // arguments never appear anywhere on the row (only their hash).
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
