import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, mcpInvocation, user } from "@alfred/db/schemas";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq, inArray, like } from "drizzle-orm";

import {
  McpRawClient,
  type ExternalToolRef,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
} from "../../src/modules/mcp";
import { McpExecutionBroker } from "../../src/modules/mcp/broker";
import { McpClientError } from "../../src/modules/mcp/errors";
import { canonicalArgsHash, descriptorHash } from "../../src/modules/mcp/hash";
import { McpConnectionManager } from "../../src/modules/mcp/manager";
import {
  createSuccessorInvocation,
  insertConnection,
  upsertToolPolicy,
} from "../../src/modules/mcp/persistence";

/**
 * DB-backed offline tests for the execution broker (PRD #540). A real
 * `McpRawClient` is wired to a controllable FAKE `McpProtocolClient`, so the full
 * connect → refresh → ledger → call path runs with no socket. Opt-in on
 * `DATABASE_URL`, mirroring the other MCP tests.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-mcpbrk-";
const createdUserIds: string[] = [];

type CallBehavior =
  | { kind: "ok" }
  | { kind: "tool_error" }
  | { kind: "throw"; error: unknown };

class FakeProtocol implements McpProtocolClient {
  tools: Tool[];
  behavior: CallBehavior = { kind: "ok" };
  calls = 0;
  negotiated: McpNegotiatedServer = {
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
    return this.negotiated;
  }
  async close(): Promise<void> {}
  async listTools(): Promise<McpProtocolPage> {
    return { tools: this.tools };
  }
  async callTool(): Promise<McpProtocolCallResult> {
    this.calls += 1;
    if (this.behavior.kind === "throw") throw this.behavior.error;
    if (this.behavior.kind === "tool_error") {
      return { content: [{ type: "text", text: "nope" }], isError: true };
    }
    return { content: [{ type: "text", text: "ok" }] };
  }
  onToolsChanged(): void {}
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
  await db().insert(agentRuns).values({
    id: `run_${randomUUID().slice(0, 12)}`,
    userId,
    workflowSlug: "chat",
    currentStep: "dispatch-tools",
  });
  return userId;
}

async function seedStaging(userId: string): Promise<string> {
  const [run] = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId))
    .limit(1);
  assert.ok(run, "seed run missing");
  const stagingId = `stg_${randomUUID().slice(0, 12)}`;
  await db().insert(actionStagings).values({
    id: stagingId,
    userId,
    runId: run.id,
    stepId: "dispatch-tools",
    toolCallId: `tc_${randomUUID().slice(0, 8)}`,
    toolName: "mcp.call",
    integration: "mcp",
    riskTier: "high",
    proposedInput: {},
    proposedInputHash: randomUUID(),
    requiresApproval: true,
  });
  return stagingId;
}

async function seedConnection(userId: string): Promise<string> {
  const conn = await insertConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpointUrl: "https://mcp.example.test/mcp",
    endpointOrigin: "https://mcp.example.test",
  });
  return conn.id;
}

function brokerWith(protocol: FakeProtocol): McpExecutionBroker {
  const manager = new McpConnectionManager({
    clientFactory: (connection) =>
      new McpRawClient({
        connectionId: connection.id,
        endpoint: new URL(connection.endpointUrl),
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
        endpoint: new URL(connection.endpointUrl),
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

describe("mcp execution broker (DB-backed, offline)", { skip: SKIP }, () => {
  before(async () => {
    await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));
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

  test("a definitive tool_error resolves rejected and stays retry-safe", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    protocol.behavior = { kind: "tool_error" };
    const revision = await liveRevision(protocol, connId);

    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);
    const outcome = await broker.callTool({
      userId,
      stagingId,
      ref: { kind: "mcp", connectionId: connId, remoteName: "create_issue", catalogRevision: revision },
      arguments: {},
    });

    assert.equal(outcome.status, "tool_error");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectOutcome, "rejected");
    assert.equal(row?.retryDisposition, "safe");
    assert.ok(row?.resolvedAt);
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

  test("a deterministic pre-delivery error throws and resolves the reservation as not-delivered", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const protocol = new FakeProtocol([tool("create_issue")]);
    await liveRevision(protocol, connId);

    const broker = brokerWith(protocol);
    const stagingId = await seedStaging(userId);
    const callsBefore = protocol.calls;

    // A stale catalog revision is rejected by the raw client BEFORE any send.
    await assert.rejects(
      broker.callTool({
        userId,
        stagingId,
        ref: {
          kind: "mcp",
          connectionId: connId,
          remoteName: "create_issue",
          catalogRevision: "sha256:stale",
        },
        arguments: {},
      }),
      /catalog changed|refresh/i,
    );

    assert.equal(protocol.calls, callsBefore, "a stale-catalog call must not be dispatched");
    const [row] = await invocationsForStaging(stagingId);
    assert.equal(row?.effectOutcome, "failed");
    assert.equal(row?.retryDisposition, "safe");
    assert.ok(row?.resolvedAt, "a proven not-delivered call is resolved (retry-safe)");
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
      error: new StreamableHTTPError(404, "session expired mid-call"),
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

    // Only the host-owned successor path may authorize a second attempt. It
    // resolves the prior and mints exactly one tied successor; a fresh model
    // proposal still cannot self-authorize (it now collides with the successor).
    const successorResult = await createSuccessorInvocation({
      priorId: firstOutcome.invocationId,
      priorResolutionReason: "superseded_by_successor",
      successor: {
        stagingId: await seedStaging(userId),
        userId,
        connectionId: connId,
        remoteName: "charge_card",
        argsHash: canonicalArgsHash(args),
      },
    });
    assert.ok(successorResult.ok);
    assert.equal(successorResult.successor.successorOf, firstOutcome.invocationId);
    const [prior] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, firstOutcome.invocationId));
    assert.ok(prior?.resolvedAt, "the successor path resolves the prior invocation");

    const stillBlocked = await reconnectedBroker.callTool({
      userId,
      stagingId: await seedStaging(userId),
      ref,
      arguments: args,
    });
    assert.equal(stillBlocked.status, "blocked");
    assert.equal(protocol.calls, 1, "a model proposal can never self-authorize a successor");
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
      ref: { kind: "mcp", connectionId: connId, remoteName: "create_issue", catalogRevision: revision },
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
  // response is received — for a clean success AND a definitive tool_error.
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
    assert.equal(errOutcome.status, "tool_error");
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
      (err: unknown) =>
        err instanceof McpClientError && err.code === "not_connected",
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
      ref: { kind: "mcp", connectionId: connId, remoteName: "create_issue", catalogRevision: revision },
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
      ref: { kind: "mcp", connectionId: connId, remoteName: "charge_card", catalogRevision: revision },
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
      ref: { kind: "mcp", connectionId: connId, remoteName: "charge_card", catalogRevision: revision },
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
