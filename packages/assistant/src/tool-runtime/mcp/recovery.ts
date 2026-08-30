/**
 * Product-facing MCP recovery door. It owns both durable ambiguity barriers:
 * `mcp_invocation` and `action_stagings`. No caller can supply replacement call
 * data; a successor always copies the exact persisted, owner-scoped staging input.
 */

import {
  Errors,
  hashToolInput,
  mcpCallInput,
  mcpRecoveryOperationSchema,
  type McpRecoveryDecision,
  type McpRecoveryMutationResult,
  type McpRecoveryOperation,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { createId, requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import {
  actionStagings,
  mcpConnections,
  mcpInvocation,
  type McpInvocation,
} from "@alfred/db/schemas";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import { canonicalArgsHash } from "@alfred/assistant/connections/mcp";
import { getMcpExecutionBroker } from "./runtime";
import { insertInvocation, resolveMcpToolIdentity } from "./invocations";
import type { McpBrokerOutcome } from "./broker";

const RESOLUTION_REASONS = {
  confirmed_succeeded: "user_confirmed_succeeded",
  confirmed_not_applied: "user_confirmed_not_applied",
} as const satisfies Record<McpRecoveryDecision, string>;

type ReservedSuccessor = { priorId: string; successor: McpInvocation };

export async function listMcpRecoveryOperations(
  userId: string,
  runner: DbRunner = db(),
): Promise<McpRecoveryOperation[]> {
  const rows = await runner
    .select({
      invocationId: mcpInvocation.id,
      successorOf: mcpInvocation.successorOf,
      connection: { id: mcpConnections.id, label: mcpConnections.label },
      remoteName: mcpInvocation.remoteName,
      displayInput: actionStagings.displayInput,
      attemptLifecycle: mcpInvocation.attemptLifecycle,
      effectOutcome: mcpInvocation.effectOutcome,
      retryDisposition: mcpInvocation.retryDisposition,
      deliveryPossibleAt: mcpInvocation.deliveryPossibleAt,
      responseReceivedAt: mcpInvocation.responseReceivedAt,
      lastError: mcpInvocation.lastError,
      traceId: mcpInvocation.traceId,
      stepId: mcpInvocation.stepId,
      toolCallId: mcpInvocation.toolCallId,
    })
    .from(mcpInvocation)
    .innerJoin(actionStagings, eq(actionStagings.id, mcpInvocation.stagingId))
    .innerJoin(mcpConnections, eq(mcpConnections.id, mcpInvocation.connectionId))
    .where(
      and(
        eq(mcpInvocation.userId, userId),
        eq(mcpConnections.userId, userId),
        ne(mcpInvocation.effectClass, "read"),
        inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
        eq(mcpInvocation.effectOutcome, "unknown"),
        eq(mcpInvocation.retryDisposition, "blocked"),
        isNull(mcpInvocation.resolvedAt),
        isNotNull(mcpInvocation.deliveryPossibleAt),
      ),
    )
    .orderBy(mcpInvocation.deliveryPossibleAt);

  return rows.map((row) => mcpRecoveryOperationSchema.parse(row));
}

export async function resolveMcpRecoveryOperation(
  input: { userId: string; invocationId: string; decision: McpRecoveryDecision },
  runner: DbRunner = db(),
): Promise<McpRecoveryMutationResult> {
  return runAtomic(runner, async (tx) => {
    const [invocation] = await tx
      .select()
      .from(mcpInvocation)
      .where(and(eq(mcpInvocation.id, input.invocationId), eq(mcpInvocation.userId, input.userId)))
      .for("update");
    if (!invocation) throw Errors.NotFoundError("MCP recovery operation not found");

    const expectedReason = RESOLUTION_REASONS[input.decision];
    if (invocation.resolvedAt) {
      if (invocation.resolutionReason !== expectedReason) {
        throw Errors.ConflictError("MCP recovery operation was already resolved differently");
      }
      return {
        status: "resolved",
        invocationId: invocation.id,
        successorInvocationId: null,
      };
    }
    if (invocation.effectOutcome !== "unknown" || invocation.retryDisposition !== "blocked") {
      throw Errors.ConflictError("MCP recovery operation is not awaiting a decision");
    }

    const [staging] = await tx
      .select({ id: actionStagings.id, outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(
        and(eq(actionStagings.id, invocation.stagingId), eq(actionStagings.userId, input.userId)),
      )
      .for("update");
    if (!staging) throw Errors.NotFoundError("MCP recovery operation not found");
    if (staging.outcome !== "unknown") {
      throw Errors.ConflictError("MCP recovery barriers are not aligned");
    }

    const succeeded = input.decision === "confirmed_succeeded";
    const now = new Date();
    await tx
      .update(mcpInvocation)
      .set({
        effectOutcome: succeeded ? "succeeded" : "failed",
        retryDisposition: "safe",
        resolvedAt: now,
        resolutionReason: expectedReason,
      })
      .where(eq(mcpInvocation.id, invocation.id));
    await tx
      .update(actionStagings)
      .set({
        outcome: succeeded ? "succeeded" : "failed",
        status: succeeded ? "executed" : "failed",
        executedAt: now,
        decidedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(eq(actionStagings.id, staging.id));

    return {
      status: "resolved",
      invocationId: invocation.id,
      successorInvocationId: null,
    };
  });
}

async function reserveMcpRecoverySuccessor(
  input: { userId: string; invocationId: string },
  runner: DbRunner = db(),
): Promise<ReservedSuccessor> {
  return runAtomic(runner, async (tx) => {
    const [prior] = await tx
      .select()
      .from(mcpInvocation)
      .where(and(eq(mcpInvocation.id, input.invocationId), eq(mcpInvocation.userId, input.userId)))
      .for("update");
    if (!prior) throw Errors.NotFoundError("MCP recovery operation not found");

    const [existing] = await tx
      .select()
      .from(mcpInvocation)
      .where(and(eq(mcpInvocation.successorOf, prior.id), eq(mcpInvocation.userId, input.userId)))
      .limit(1);
    if (existing) return { priorId: prior.id, successor: existing };
    if (prior.resolvedAt) {
      throw Errors.ConflictError("MCP recovery operation was already resolved");
    }
    if (prior.effectOutcome !== "unknown" || prior.retryDisposition !== "blocked") {
      throw Errors.ConflictError("MCP recovery operation is not retryable");
    }

    const [staging] = await tx
      .select()
      .from(actionStagings)
      .where(and(eq(actionStagings.id, prior.stagingId), eq(actionStagings.userId, input.userId)))
      .for("update");
    if (!staging) throw Errors.NotFoundError("MCP recovery operation not found");
    if (staging.outcome !== "unknown") {
      throw Errors.ConflictError("MCP recovery barriers are not aligned");
    }

    const call = mcpCallInput.safeParse(staging.decidedInput ?? staging.proposedInput);
    if (!call.success) throw Errors.ConflictError("Stored MCP recovery input is invalid");
    if (
      call.data.connectionId !== prior.connectionId ||
      call.data.remoteName !== prior.remoteName ||
      canonicalArgsHash(call.data.arguments) !== prior.argsHash
    ) {
      throw Errors.ConflictError("Stored MCP recovery input no longer matches the invocation");
    }

    const identity = await resolveMcpToolIdentity(
      {
        userId: input.userId,
        connectionId: call.data.connectionId,
        remoteName: call.data.remoteName,
        catalogRevision: call.data.catalogRevision,
      },
      tx,
    );
    if (identity.status !== "resolved" || !identity.connection.currentCatalogRevisionId) {
      throw Errors.ConflictError("The MCP tool changed; review it before trying again");
    }
    const liveEffectClass = identity.policy?.effectClass ?? "unknown";
    if (
      identity.connection.currentCatalogRevisionId !== prior.catalogRevisionId ||
      identity.descriptorHash !== prior.descriptorHash ||
      liveEffectClass === "read"
    ) {
      throw Errors.ConflictError("The MCP tool changed; review it before trying again");
    }

    const now = new Date();
    const stagingId = createId("as");
    const toolCallId = createId("mcp-recovery");
    const effectKey = `mcp-recovery:${createId()}`;
    await tx
      .update(actionStagings)
      .set({ outcome: "superseded", rowVersion: staging.rowVersion + 1, updatedAt: now })
      .where(eq(actionStagings.id, staging.id));
    const [successorStaging] = await tx
      .insert(actionStagings)
      .values({
        id: stagingId,
        userId: input.userId,
        runId: staging.runId,
        stepId: "mcp-recovery",
        toolCallId,
        toolName: "mcp.call",
        integration: "mcp",
        riskTier: identity.policy?.riskTier ?? "high",
        proposedInput: call.data,
        displayInput: staging.displayInput,
        proposedInputHash: hashToolInput("mcp.call", call.data),
        requiresApproval: true,
        status: "approved",
        outcome: "dispatching",
        effectKey,
        attemptKey: `${effectKey}:1`,
        requestHash: staging.requestHash,
        decidedInput: call.data,
        decidedAt: now,
      })
      .returning();
    requireRow(successorStaging, "reserveMcpRecoverySuccessor staging");

    await tx
      .update(mcpInvocation)
      .set({ resolvedAt: now, resolutionReason: "superseded_by_user_successor" })
      .where(eq(mcpInvocation.id, prior.id));
    const inserted = await insertInvocation(
      {
        stagingId,
        userId: input.userId,
        connectionId: call.data.connectionId,
        remoteName: call.data.remoteName,
        argsHash: prior.argsHash,
        catalogRevisionId: identity.connection.currentCatalogRevisionId,
        descriptorHash: identity.descriptorHash,
        ...(identity.policy ? { policyRevision: identity.policy.policyRevision } : {}),
        effectClass: liveEffectClass,
        attemptLifecycle: "prepared",
        successorOf: prior.id,
      },
      tx,
    );
    if (!inserted.ok) {
      throw Errors.ConflictError("A matching MCP recovery operation is already reserved");
    }
    return { priorId: prior.id, successor: inserted.invocation };
  });
}

export async function retryMcpRecoveryOperation(input: {
  userId: string;
  invocationId: string;
  signal?: AbortSignal;
}): Promise<McpRecoveryMutationResult> {
  const reserved = await reserveMcpRecoverySuccessor(input);
  const outcome: McpBrokerOutcome = await getMcpExecutionBroker().resumeReservedSuccessor({
    userId: input.userId,
    invocationId: reserved.successor.id,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    status: outcome.status,
    invocationId: reserved.priorId,
    successorInvocationId: reserved.successor.id,
  };
}
