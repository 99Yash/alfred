/**
 * Product-facing MCP recovery door. It owns both durable ambiguity barriers:
 * `mcp_invocation` and `action_stagings`. No caller can supply replacement call
 * data; a successor always copies the exact persisted, owner-scoped staging input.
 *
 * The list is a pure read. It never repairs a row and never constructs the
 * broker. Rows whose provider phase ended but whose settlement is not recorded
 * yet are reported as a count (`awaitingRepair`), not hidden behind a live
 * cursor; the broker's drain timer and boot reconciliation normalize them.
 */

import { Buffer } from "node:buffer";

import {
  Errors,
  MCP_RECOVERY_PAGE_SIZE,
  hashToolInput,
  jsonValueSchema,
  mcpCallInput,
  mcpRecoveryOperationSchema,
  mcpRecoveryOperationsPageInputSchema,
  mcpRecoveryOperationsPageSchema,
  parseJsonWith,
  type McpRecoveryDecision,
  type McpRecoveryMutationResult,
  type McpRecoveryOperationsPageInput,
  type McpRecoveryOperationsPage,
} from "@alfred/contracts";
import { publicAppError } from "@alfred/contracts/app-errors";
import { db } from "@alfred/db";
import { createId, requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import {
  actionStagings,
  mcpConnections,
  mcpInvocation,
  type McpInvocation,
} from "@alfred/db/schemas";
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { canonicalArgsHash } from "@alfred/assistant/connections/mcp";
import { getMcpExecutionBroker } from "./runtime";
import { resolveMcpToolIdentity } from "./invocations";
import { effectiveMcpRiskTier } from "./risk";
import type { McpBrokerOutcome } from "./broker";

const RESOLUTION_REASONS = {
  confirmed_succeeded: "user_confirmed_succeeded",
  confirmed_not_applied: "user_confirmed_not_applied",
} as const satisfies Record<McpRecoveryDecision, string>;

type ReservedSuccessor = { priorId: string; successor: McpInvocation };

export type { McpRecoveryOperationsPageInput } from "@alfred/contracts";

// ---------------------------------------------------------------------------
// Keyset order. The cursor carries a JavaScript ISO timestamp, which has
// millisecond precision, while PostgreSQL stores microseconds. The SQL key is
// therefore truncated to milliseconds on BOTH sides of the comparison: a row
// whose `created_at` is `12:00:00.123456` must sort exactly where the cursor
// that names it as `.123` says it does, or the boundary row repeats on the next
// page (and a `<=` frontier would drop it).
// ---------------------------------------------------------------------------

export const mcpRecoveryOrderKeySchema = z
  .object({ timestamp: z.string().datetime(), invocationId: z.string() })
  .strict();

export type McpRecoveryOrderKey = z.infer<typeof mcpRecoveryOrderKeySchema>;

export const mcpRecoveryEffectiveAt = sql<string>`date_trunc('milliseconds', coalesce(${mcpInvocation.deliveryPossibleAt}, ${mcpInvocation.createdAt}))`;

export function mcpRecoveryOrderKey(input: {
  effectiveAt: string | Date;
  invocationId: string;
}): McpRecoveryOrderKey {
  return {
    timestamp: new Date(input.effectiveAt).toISOString(),
    invocationId: input.invocationId,
  };
}

export function afterMcpRecoveryOrderKey(key: McpRecoveryOrderKey) {
  return sql`(${mcpRecoveryEffectiveAt}, ${mcpInvocation.id}) > (${new Date(key.timestamp)}, ${key.invocationId})`;
}

function decodeRecoveryCursor(cursor: string | undefined): McpRecoveryOrderKey | undefined {
  if (!cursor) return undefined;
  const key = parseJsonWith(
    Buffer.from(cursor, "base64url").toString("utf8"),
    mcpRecoveryOrderKeySchema,
  );
  if (!key) throw Errors.BadRequestError("Invalid MCP recovery cursor");
  return key;
}

function encodeRecoveryCursor(key: McpRecoveryOrderKey): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

/**
 * Rows whose provider phase ended (the dispatcher committed the staging row to a
 * terminal status) but whose broker settlement was never recorded on the
 * invocation. They are invisible to the product projection until the broker's
 * drain or boot reconciliation normalizes them, so the page reports how many
 * there are instead of hiding them behind an empty page.
 */
async function countAwaitingRepair(userId: string, runner: DbRunner): Promise<number> {
  const [row] = await runner
    .select({ value: count() })
    .from(mcpInvocation)
    .innerJoin(actionStagings, eq(actionStagings.id, mcpInvocation.stagingId))
    .where(
      and(
        eq(mcpInvocation.userId, userId),
        eq(actionStagings.userId, userId),
        ne(mcpInvocation.effectClass, "read"),
        inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
        isNull(mcpInvocation.effectOutcome),
        isNull(mcpInvocation.resolvedAt),
        inArray(actionStagings.status, ["executed", "failed"]),
      ),
    );
  return row?.value ?? 0;
}

export async function listMcpRecoveryOperations(
  input: McpRecoveryOperationsPageInput,
  runner: DbRunner = db(),
): Promise<McpRecoveryOperationsPage> {
  const ownedInput = mcpRecoveryOperationsPageInputSchema.parse(input);
  const after = decodeRecoveryCursor(ownedInput.cursor);
  const [rows, awaitingRepair] = await Promise.all([
    runner
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
        effectiveAt: mcpRecoveryEffectiveAt,
      })
      .from(mcpInvocation)
      .innerJoin(actionStagings, eq(actionStagings.id, mcpInvocation.stagingId))
      .innerJoin(mcpConnections, eq(mcpConnections.id, mcpInvocation.connectionId))
      .where(
        and(
          eq(mcpInvocation.userId, ownedInput.userId),
          eq(mcpConnections.userId, ownedInput.userId),
          ne(mcpInvocation.effectClass, "read"),
          isNull(mcpInvocation.resolvedAt),
          or(
            and(
              inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
              eq(mcpInvocation.effectOutcome, "unknown"),
              eq(mcpInvocation.retryDisposition, "blocked"),
              isNotNull(mcpInvocation.deliveryPossibleAt),
            ),
            and(
              eq(mcpInvocation.attemptLifecycle, "prepared"),
              isNotNull(mcpInvocation.successorOf),
              isNull(mcpInvocation.effectOutcome),
              isNull(mcpInvocation.retryDisposition),
              isNull(mcpInvocation.deliveryPossibleAt),
            ),
          ),
          ...(after ? [afterMcpRecoveryOrderKey(after)] : []),
        ),
      )
      .orderBy(asc(mcpRecoveryEffectiveAt), asc(mcpInvocation.id))
      .limit(MCP_RECOVERY_PAGE_SIZE + 1),
    countAwaitingRepair(ownedInput.userId, runner),
  ]);

  const pageRows = rows.slice(0, MCP_RECOVERY_PAGE_SIZE);
  const last = pageRows.at(-1);
  return mcpRecoveryOperationsPageSchema.parse({
    operations: pageRows.map(({ effectiveAt: _effectiveAt, ...row }) =>
      mcpRecoveryOperationSchema.parse(row),
    ),
    nextCursor:
      rows.length > MCP_RECOVERY_PAGE_SIZE && last
        ? encodeRecoveryCursor(mcpRecoveryOrderKey(last))
        : null,
    awaitingRepair,
  });
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
        // A `failed` staging row is replayed to the model through its stored
        // error. The user's statement is the error here: the effect did not
        // apply and Alfred did not repeat it. Without it the replay reads as a
        // generic provider failure.
        ...(succeeded
          ? {}
          : { executeError: jsonValueSchema.parse(publicAppError("mcp_effect_not_applied")) }),
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

/**
 * The successor is one more attempt of the SAME logical effect, so it inherits
 * the prior row's `effect_key` and takes the next attempt number, the same way
 * `attemptKeyFor` spells a first attempt as `<effect_key>:1`.
 */
function nextAttemptKey(staging: { effectKey: string; attemptKey: string }): string {
  const suffix = /:(\d+)$/.exec(staging.attemptKey);
  const prior = suffix?.[1] ? Number.parseInt(suffix[1], 10) : 1;
  return `${staging.effectKey}:${prior + 1}`;
}

async function reserveMcpRecoverySuccessor(
  input: { userId: string; invocationId: string },
  runner: DbRunner = db(),
): Promise<ReservedSuccessor> {
  return runAtomic(runner, async (tx) => {
    // Read only the pointer needed to establish the lock order. Connection
    // authority is locked first; catalog publishers, ownership changes, and the
    // policy writer all serialize on this row. The invocation and staging locks
    // come next, so validation and both barrier transitions use one stable
    // authority snapshot.
    const [requestedRef] = await tx
      .select({ connectionId: mcpInvocation.connectionId })
      .from(mcpInvocation)
      .where(and(eq(mcpInvocation.id, input.invocationId), eq(mcpInvocation.userId, input.userId)))
      .limit(1);
    if (!requestedRef) throw Errors.NotFoundError("MCP recovery operation not found");

    const [lockedConnection] = await tx
      .select({
        id: mcpConnections.id,
        currentCatalogRevisionId: mcpConnections.currentCatalogRevisionId,
      })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.id, requestedRef.connectionId),
          eq(mcpConnections.userId, input.userId),
        ),
      )
      .for("update");
    if (!lockedConnection) throw Errors.NotFoundError("MCP recovery operation not found");

    const [prior] = await tx
      .select()
      .from(mcpInvocation)
      .where(and(eq(mcpInvocation.id, input.invocationId), eq(mcpInvocation.userId, input.userId)))
      .for("update");
    if (!prior || prior.connectionId !== lockedConnection.id) {
      throw Errors.NotFoundError("MCP recovery operation not found");
    }

    // A refreshed product posts the visible prepared successor's own id. This is
    // the same closed action as posting the prior id: return the already-minted
    // reservation, and let the broker's prepared-only claim decide whether one
    // send is still allowed.
    if (
      prior.successorOf &&
      prior.attemptLifecycle === "prepared" &&
      !prior.resolvedAt &&
      prior.effectOutcome === null
    ) {
      return { priorId: prior.successorOf, successor: prior };
    }

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
      (identity.policy?.policyRevision ?? null) !== prior.policyRevision ||
      liveEffectClass === "read"
    ) {
      throw Errors.ConflictError("The MCP tool changed; review it before trying again");
    }

    const now = new Date();
    const stagingId = createId("as");
    const toolCallId = createId("mcp-recovery");
    // The prior row leaves `unknown` so the successor can hold the one unresolved
    // slot the `(user_id, request_hash) WHERE outcome = 'unknown'` index admits
    // per effect. See `effectOutcomeSchema` for what `superseded` claims.
    await tx
      .update(actionStagings)
      .set({
        outcome: "superseded",
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
        updatedAt: now,
      })
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
        // The same guarded derivation the dispatch gate applies: an unreviewed or
        // out-of-enum tier re-gates to the floor instead of un-gating.
        riskTier: effectiveMcpRiskTier(identity),
        proposedInput: call.data,
        displayInput: staging.displayInput,
        proposedInputHash: hashToolInput("mcp.call", call.data),
        requiresApproval: true,
        status: "approved",
        outcome: "dispatching",
        effectKey: staging.effectKey,
        attemptKey: nextAttemptKey(staging),
        requestHash: staging.requestHash,
        decidedInput: call.data,
        decidedAt: now,
      })
      .returning();
    const successorStagingRow = requireRow(successorStaging, "reserveMcpRecoverySuccessor staging");

    await tx
      .update(mcpInvocation)
      .set({ resolvedAt: now, resolutionReason: "superseded_by_user_successor" })
      .where(eq(mcpInvocation.id, prior.id));
    const [successor] = await tx
      .insert(mcpInvocation)
      .values({
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
        traceId: successorStagingRow.runId,
        stepId: successorStagingRow.stepId,
        toolCallId: successorStagingRow.toolCallId,
      })
      .returning();
    return {
      priorId: prior.id,
      successor: requireRow(successor, "reserveMcpRecoverySuccessor invocation"),
    };
  });
}

/**
 * Reserve and deliver one explicit successor. The input carries no
 * `AbortSignal` on purpose: the resume is the one send that must not share an
 * HTTP request's lifetime (see `McpReservedSuccessorInput`).
 */
export async function retryMcpRecoveryOperation(input: {
  userId: string;
  invocationId: string;
}): Promise<McpRecoveryMutationResult> {
  const reserved = await reserveMcpRecoverySuccessor(input);
  const outcome: McpBrokerOutcome = await getMcpExecutionBroker().resumeReservedSuccessor({
    userId: input.userId,
    invocationId: reserved.successor.id,
  });
  return {
    status: outcome.status,
    invocationId: reserved.priorId,
    successorInvocationId: reserved.successor.id,
  };
}
