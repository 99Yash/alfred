import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { canonicalArgsHash } from "@alfred/assistant/connections/mcp";
import { MCP_RECOVERY_PAGE_SIZE } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, mcpInvocation, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { createNamedConnection } from "../../src/connections/mcp/persistence";
import { reconcileInflightInvocations } from "../../src/tool-runtime/mcp/invocations";
import {
  listMcpRecoveryOperations,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
} from "../../src/tool-runtime/mcp/recovery";
import { seedMcpInvocationForTests } from "../../src/tool-runtime/mcp/test-support";
import { dbBackedSkip } from "../support/db-backed";

const SKIP = dbBackedSkip("database");
const ID_PREFIX = "test-mcprec-";
const createdUserIds: string[] = [];

async function seedAmbiguousOperation(options: { splitBarrier?: "dispatching" | "failed" } = {}) {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({
      id: userId,
      name: "Recovery User",
      email: `${userId}@example.test`,
    });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId,
    workflowSlug: "chat",
    currentStep: "dispatch-tools",
  });
  const connection = await createNamedConnection({
    userId,
    label: "Recovery MCP",
    canonicalResource: `mcp://recovery/${randomUUID()}`,
    endpoint: new URL("https://recovery.example.test/mcp"),
  });
  const argumentsValue = { invoiceId: "inv_42" };
  const proposedInput = {
    connectionId: connection.id,
    remoteName: "send_invoice",
    catalogRevision: "revision-1",
    arguments: argumentsValue,
  };
  const stagingId = `as_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(actionStagings)
    .values({
      id: stagingId,
      userId,
      runId,
      stepId: "dispatch-tools",
      toolCallId: `tc_${randomUUID().slice(0, 8)}`,
      toolName: "mcp.call",
      integration: "mcp",
      riskTier: "high",
      proposedInput,
      displayInput: { invoiceId: "inv_42" },
      proposedInputHash: randomUUID(),
      effectKey: `eff:${runId}:recovery`,
      attemptKey: `eff:${runId}:recovery:1`,
      requestHash: `req:${randomUUID()}`,
      requiresApproval: true,
      status:
        options.splitBarrier === "dispatching"
          ? "approved"
          : options.splitBarrier === "failed"
            ? "failed"
            : "executed",
      outcome: options.splitBarrier ?? "unknown",
    });
  const inserted = await seedMcpInvocationForTests({
    stagingId,
    userId,
    connectionId: connection.id,
    remoteName: "send_invoice",
    argsHash: canonicalArgsHash(argumentsValue),
    effectClass: "write",
    attemptLifecycle: "delivery_possible",
    effectOutcome: options.splitBarrier ? null : "unknown",
    retryDisposition: options.splitBarrier ? null : "blocked",
    deliveryPossibleAt: new Date(),
    lastError: "socket closed after request",
  });
  return { userId, runId, connectionId: connection.id, stagingId, invocationId: inserted.id };
}

describe("MCP recovery operations (DB-backed)", { skip: SKIP }, () => {
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

  test("lists only the owner's safe unresolved projection", async () => {
    const seeded = await seedAmbiguousOperation();
    const other = await seedAmbiguousOperation();

    const operations = (await listMcpRecoveryOperations({ userId: seeded.userId })).operations;

    assert.equal(operations.length, 1);
    assert.equal(operations[0]?.invocationId, seeded.invocationId);
    assert.deepEqual(operations[0]?.displayInput, { invoiceId: "inv_42" });
    assert.equal(operations[0]?.connection.label, "Recovery MCP");
    assert.ok(!JSON.stringify(operations).includes(other.invocationId));
    assert.ok(!("proposedInput" in (operations[0] ?? {})));
  });

  test("pages by effective timestamp and invocation id without gaps or duplicates", async () => {
    const seeded = await seedAmbiguousOperation();
    const effectiveAt = new Date("2026-08-30T12:00:00.000Z");
    await db()
      .update(mcpInvocation)
      .set({ deliveryPossibleAt: effectiveAt })
      .where(eq(mcpInvocation.id, seeded.invocationId));

    for (let index = 0; index < MCP_RECOVERY_PAGE_SIZE; index += 1) {
      const stagingId = `as_${randomUUID().slice(0, 12)}`;
      await db()
        .insert(actionStagings)
        .values({
          id: stagingId,
          userId: seeded.userId,
          runId: seeded.runId,
          stepId: "dispatch-tools",
          toolCallId: `tc_${randomUUID().slice(0, 8)}`,
          toolName: "mcp.call",
          integration: "mcp",
          riskTier: "high",
          proposedInput: {},
          displayInput: { index },
          proposedInputHash: randomUUID(),
          effectKey: `eff:${seeded.runId}:page:${index}`,
          attemptKey: `eff:${seeded.runId}:page:${index}:1`,
          requestHash: `req:${randomUUID()}`,
          requiresApproval: true,
          status: "executed",
          outcome: "unknown",
        });
      await seedMcpInvocationForTests({
        stagingId,
        userId: seeded.userId,
        connectionId: seeded.connectionId,
        remoteName: `send_invoice_${index}`,
        argsHash: `sha256:page:${index}`,
        effectClass: "write",
        attemptLifecycle: "delivery_possible",
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        deliveryPossibleAt: effectiveAt,
      });
    }

    const first = await listMcpRecoveryOperations({ userId: seeded.userId });
    assert.equal(first.operations.length, MCP_RECOVERY_PAGE_SIZE);
    assert.ok(first.nextCursor);
    const second = await listMcpRecoveryOperations({
      userId: seeded.userId,
      cursor: first.nextCursor!,
    });
    assert.equal(second.operations.length, 1);
    assert.equal(second.nextCursor, null);
    const ids = [...first.operations, ...second.operations].map((row) => row.invocationId);
    assert.equal(new Set(ids).size, MCP_RECOVERY_PAGE_SIZE + 1);
    assert.deepEqual(ids, [...ids].sort(), "the id tiebreaker is stable at one timestamp");

    await assert.rejects(
      listMcpRecoveryOperations({ userId: seeded.userId, cursor: "not-a-cursor" }),
      /Invalid MCP recovery cursor/,
    );
  });

  test("a confirmed outcome resolves both durable barriers atomically", async () => {
    const seeded = await seedAmbiguousOperation();

    const result = await resolveMcpRecoveryOperation({
      userId: seeded.userId,
      invocationId: seeded.invocationId,
      decision: "confirmed_not_applied",
    });

    assert.deepEqual(result, {
      status: "resolved",
      invocationId: seeded.invocationId,
      successorInvocationId: null,
    });
    const [invocation] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, seeded.invocationId));
    const [staging] = await db()
      .select()
      .from(actionStagings)
      .where(eq(actionStagings.id, seeded.stagingId));
    assert.equal(invocation?.effectOutcome, "failed");
    assert.equal(invocation?.retryDisposition, "safe");
    assert.ok(invocation?.resolvedAt);
    assert.equal(staging?.outcome, "failed");
    assert.equal(staging?.status, "failed");
    assert.equal((await listMcpRecoveryOperations({ userId: seeded.userId })).operations.length, 0);
  });

  test("an ownership miss cannot resolve another user's operation", async () => {
    const seeded = await seedAmbiguousOperation();
    const attacker = await seedAmbiguousOperation();

    await assert.rejects(
      resolveMcpRecoveryOperation({
        userId: attacker.userId,
        invocationId: seeded.invocationId,
        decision: "confirmed_succeeded",
      }),
      /MCP recovery operation not found/,
    );
  });

  test("boot alignment makes a post-broker crash resolvable without another send", async () => {
    const seeded = await seedAmbiguousOperation({ splitBarrier: "dispatching" });

    const livePage = await listMcpRecoveryOperations({ userId: seeded.userId });
    assert.equal(
      livePage.operations.length,
      0,
      "a delivery_possible row with a live dispatching staging is not exposed",
    );

    const boot = await reconcileInflightInvocations(seeded.userId);
    assert.equal(boot.markedUnknown, 1);
    assert.equal(boot.alignedStagingBarriers, 1);
    const result = await resolveMcpRecoveryOperation({
      userId: seeded.userId,
      invocationId: seeded.invocationId,
      decision: "confirmed_succeeded",
    });

    assert.equal(result.status, "resolved");
    const [staging] = await db()
      .select({ status: actionStagings.status, outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(eq(actionStagings.id, seeded.stagingId));
    assert.deepEqual(staging, { status: "executed", outcome: "succeeded" });
  });

  test("boot aligns a dispatcher failed staging row before recovery resolution", async () => {
    const seeded = await seedAmbiguousOperation({ splitBarrier: "failed" });

    const boot = await reconcileInflightInvocations(seeded.userId);
    assert.equal(boot.markedUnknown, 1);
    assert.equal(boot.alignedStagingBarriers, 1);
    const result = await resolveMcpRecoveryOperation({
      userId: seeded.userId,
      invocationId: seeded.invocationId,
      decision: "confirmed_not_applied",
    });
    assert.equal(result.status, "resolved");
  });

  test("catalog drift fails before either ambiguity barrier changes", async () => {
    const seeded = await seedAmbiguousOperation();

    await assert.rejects(
      retryMcpRecoveryOperation({
        userId: seeded.userId,
        invocationId: seeded.invocationId,
      }),
      /MCP tool changed/,
    );

    const [invocation] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, seeded.invocationId));
    const [staging] = await db()
      .select()
      .from(actionStagings)
      .where(eq(actionStagings.id, seeded.stagingId));
    const successors = await db()
      .select({ id: mcpInvocation.id })
      .from(mcpInvocation)
      .where(eq(mcpInvocation.successorOf, seeded.invocationId));
    assert.equal(invocation?.resolvedAt, null);
    assert.equal(invocation?.effectOutcome, "unknown");
    assert.equal(staging?.outcome, "unknown");
    assert.equal(successors.length, 0);
  });
});
