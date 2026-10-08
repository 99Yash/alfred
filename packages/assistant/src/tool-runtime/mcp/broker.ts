/**
 * Runs one authorized `mcp.call` through the ambiguity ledger.
 * Policy drift falls back to `unknown`. A write gets a barrier row before it is
 * sent, so a possibly-delivered write is never repeated
 * (docs/research/mcp-ambiguous-write-outcomes.md). Only `recovery.ts` mints successors.
 */

import {
  isBuiltInObjectStateProvider,
  mcpCallInput,
  mcpHealthMappingDefinitionSchema,
  type McpCallInput,
  type McpEffectClass,
  type McpResultProvenance,
  unrefTimer,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { requireRow, runAtomic } from "@alfred/db/helpers";
import { isUniqueViolation, uniqueViolationConstraint } from "@alfred/db/pg-errors";
import {
  actionStagings,
  mcpConnections,
  mcpHealthMapping,
  mcpInvocation,
  type McpInvocation,
  type McpToolPolicyRow,
  type NewMcpInvocation,
} from "@alfred/db/schemas";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  boundedMcpErrorText,
  canonicalArgsHash,
  descriptorHash,
  isPreDeliveryErrorCode,
  McpClientError,
  startMcpTraceSpan,
  type ExternalToolRef,
  type McpCallEnvelope,
  type McpConnectionManager,
  type McpPreparedToolCall,
  type McpTraceContext,
} from "@alfred/assistant/connections/mcp";
import {
  findUnresolvedBarrier,
  isReadOnlyMcpToolIdentity,
  readInvocationByStagingId,
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type OwnedMcpConnectionRef,
} from "./invocations";
import { effectiveMcpRiskTier } from "./risk";
import {
  hasMcpBrokerAdmissionCapacity,
  MCP_SETTLEMENT_REPAIR_BATCH_SIZE,
  MCP_SETTLEMENT_REPAIR_RETRY_MS,
} from "./broker-policy";

const BLOCKED_BARRIER_MESSAGE =
  "A matching write to this MCP tool is already unresolved (it may have been delivered). " +
  "It will not be repeated until its outcome is confirmed or explicitly superseded.";

const BLOCKED_RECORDED_MESSAGE =
  "This exact call was already recorded and may have been delivered. " +
  "Its outcome must be checked before it can be attempted again.";

const AMBIGUOUS_MESSAGE =
  "The remote MCP write may have completed, but Alfred did not receive a confirmation. " +
  "It will not be repeated automatically until its state is checked.";

const MCP_TOOL_ERROR_MESSAGE =
  "The remote MCP tool reported an error after delivery, but its effect may still have been applied.";

export interface McpBrokerCallInput {
  userId: string;
  /** The `action_stagings` row that authorized this call (1:1 with the ledger row). */
  stagingId: string;
  ref: ExternalToolRef;
  /** The raw client validates these against the tool schema. */
  arguments: unknown;
  /** Run trace id. Observability only; ledger correlation still copies the staging row. */
  traceId?: string;
  signal?: AbortSignal;
}

/** An owner-reviewed health read. The broker re-reads the mapping and takes the arguments from it. */
export interface McpHealthReadInput {
  userId: string;
  ref: ExternalToolRef;
  descriptorHash: string;
  mappingRevision: number;
  traceId?: string;
  signal?: AbortSignal;
}

/**
 * No `AbortSignal` on purpose: a closed tab must not abort a write that is
 * already `delivery_possible`. The client timeout is the only bound.
 */
export interface McpReservedSuccessorInput {
  userId: string;
  invocationId: string;
}

export type McpBrokerBlockReason = "ambiguity_barrier" | "already_recorded";

/**
 * Non-throwing outcomes. Pre-delivery failures throw instead.
 * `blocked`: nothing was sent. `ambiguous`: the write may have happened, so the row stays unresolved.
 */
export type McpBrokerOutcome =
  | { status: "completed"; invocationId: string | null; envelope: McpCallEnvelope }
  | { status: "tool_error"; invocationId: string | null; envelope: McpCallEnvelope }
  | {
      status: "blocked";
      reason: McpBrokerBlockReason;
      message: string;
      priorInvocationId: string | null;
    }
  | { status: "ambiguous"; invocationId: string; message: string };

/** True only for an `McpClientError` that provably was not delivered. */
function isProvenNotDelivered(err: unknown): boolean {
  return err instanceof McpClientError && isPreDeliveryErrorCode(err.code);
}

type NormalMcpInvocationReservation = Omit<
  Pick<
    NewMcpInvocation,
    | "stagingId"
    | "userId"
    | "connectionId"
    | "remoteName"
    | "argsHash"
    | "catalogRevisionId"
    | "descriptorHash"
    | "policyRevision"
    | "effectClass"
  >,
  "stagingId"
> & { stagingId: string };

type NormalMcpInvocationReservationResult =
  | { ok: true; invocation: McpInvocation }
  | { ok: false; reason: "barrier" | "duplicate_staging" };

type McpInvocationSettlement =
  | { kind: "succeeded"; resultProvenance: McpResultProvenance }
  | { kind: "not_delivered"; lastError: string }
  | {
      kind: "ambiguous";
      lastError: string;
      resultProvenance?: McpResultProvenance;
    };

interface PreparedMcpCall {
  identity: McpToolIdentityResolution;
  connection: OwnedMcpConnectionRef;
  prepared: McpPreparedToolCall;
  descriptorHash: string | undefined;
}

interface PendingMcpSettlementRepair {
  userId: string;
  invocationId: string;
  resultProvenance?: McpResultProvenance;
}

function pendingRepairKey(input: Pick<PendingMcpSettlementRepair, "userId" | "invocationId">) {
  return `${input.userId}:${input.invocationId}`;
}

/** Reserve a normal call. Trace ids are copied from the owned staging row. */
async function reserveNormalMcpInvocationDelivery(
  values: NormalMcpInvocationReservation,
): Promise<NormalMcpInvocationReservationResult> {
  try {
    return await runAtomic(db(), async (tx) => {
      const [correlation] = await tx
        .select({
          traceId: actionStagings.runId,
          stepId: actionStagings.stepId,
          toolCallId: actionStagings.toolCallId,
        })
        .from(actionStagings)
        .where(
          and(
            eq(actionStagings.id, values.stagingId),
            eq(actionStagings.userId, values.userId),
            eq(actionStagings.outcome, "dispatching"),
          ),
        )
        .for("update");

      if (!correlation) {
        throw new McpClientError(
          "invalid_arguments",
          "The MCP authorization is no longer dispatchable.",
        );
      }

      const [invocation] = await tx
        .insert(mcpInvocation)
        .values({
          stagingId: values.stagingId,
          userId: values.userId,
          connectionId: values.connectionId,
          remoteName: values.remoteName,
          argsHash: values.argsHash,
          effectClass: values.effectClass,
          attemptLifecycle: "delivery_possible",
          deliveryPossibleAt: new Date(),
          ...(values.catalogRevisionId ? { catalogRevisionId: values.catalogRevisionId } : {}),
          ...(values.descriptorHash ? { descriptorHash: values.descriptorHash } : {}),
          ...(values.policyRevision !== undefined ? { policyRevision: values.policyRevision } : {}),
          ...correlation,
        })
        .returning();

      return {
        ok: true,
        invocation: requireRow(invocation, "reserveNormalMcpInvocationDelivery"),
      };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    return uniqueViolationConstraint(error) === "mcp_invocation_staging_idx"
      ? { ok: false, reason: "duplicate_staging" }
      : { ok: false, reason: "barrier" };
  }
}

/** Record a completed reviewed read without adding an ambiguity barrier. */
async function recordCompletedMcpRead(input: {
  userId: string;
  stagingId: string;
  connectionId: string;
  remoteName: string;
  catalogRevisionId: string | null;
  descriptorHash: string | undefined;
  policyRevision: number;
  arguments: unknown;
  resultProvenance: McpResultProvenance;
}): Promise<string | null> {
  try {
    return await runAtomic(db(), async (tx) => {
      const [correlation] = await tx
        .select({
          traceId: actionStagings.runId,
          stepId: actionStagings.stepId,
          toolCallId: actionStagings.toolCallId,
        })
        .from(actionStagings)
        .where(
          and(
            eq(actionStagings.id, input.stagingId),
            eq(actionStagings.userId, input.userId),
            eq(actionStagings.outcome, "dispatching"),
          ),
        )
        .for("update");

      if (!correlation) {
        // The read already completed. Never throw a pre-delivery code here; return null.
        return null;
      }

      const now = new Date();

      const [invocation] = await tx
        .insert(mcpInvocation)
        .values({
          stagingId: input.stagingId,
          userId: input.userId,
          connectionId: input.connectionId,
          remoteName: input.remoteName,
          argsHash: canonicalArgsHash(input.arguments),
          effectClass: "read",
          attemptLifecycle: "response_received",
          effectOutcome: "succeeded",
          retryDisposition: "safe",
          resolvedAt: now,
          deliveryPossibleAt: now,
          responseReceivedAt: now,
          resultProvenance: input.resultProvenance,
          ...(input.catalogRevisionId ? { catalogRevisionId: input.catalogRevisionId } : {}),
          ...(input.descriptorHash ? { descriptorHash: input.descriptorHash } : {}),
          policyRevision: input.policyRevision,
          ...correlation,
        })
        .returning({ id: mcpInvocation.id });

      return requireRow(invocation, "recordCompletedMcpRead").id;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // A dispatch retry records the same read again. Reuse the row instead of a 23505.
    const prior = await readInvocationByStagingId(input.stagingId);

    return prior?.id ?? null;
  }
}

/** Re-read the owner mapping. The gather query is not authority; a cleared mapping cancels the call. */
async function readHealthMapping(input: McpHealthReadInput) {
  const [row] = await db()
    .select({ definition: mcpHealthMapping.definition })
    .from(mcpHealthMapping)
    .where(
      and(
        eq(mcpHealthMapping.userId, input.userId),
        eq(mcpHealthMapping.connectionId, input.ref.connectionId),
        eq(mcpHealthMapping.remoteName, input.ref.remoteName),
        eq(mcpHealthMapping.descriptorHash, input.descriptorHash),
        eq(mcpHealthMapping.mappingRevision, input.mappingRevision),
      ),
    )
    .limit(1);

  if (!row) return null;

  const definition = mcpHealthMappingDefinitionSchema.safeParse(row.definition);

  if (!definition.success || isBuiltInObjectStateProvider(definition.data.identityProvider)) {
    return null;
  }

  return definition.data;
}

/** Reserve a health read in the same invocation ledger as every other MCP call. */
async function reserveHealthMcpRead(input: {
  userId: string;
  connectionId: string;
  remoteName: string;
  catalogRevisionId: string | null;
  descriptorHash: string;
  policyRevision: number | undefined;
  arguments: unknown;
  traceId: string | undefined;
}): Promise<string | null> {
  try {
    const now = new Date();

    const [row] = await db()
      .insert(mcpInvocation)
      .values({
        // No staging row. The CHECK allows null only for reads.
        stagingId: null,
        userId: input.userId,
        connectionId: input.connectionId,
        remoteName: input.remoteName,
        ...(input.catalogRevisionId ? { catalogRevisionId: input.catalogRevisionId } : {}),
        descriptorHash: input.descriptorHash,
        ...(input.policyRevision !== undefined ? { policyRevision: input.policyRevision } : {}),
        argsHash: canonicalArgsHash(input.arguments),
        effectClass: "read",
        attemptLifecycle: "delivery_possible",
        deliveryPossibleAt: now,
        ...(input.traceId ? { traceId: input.traceId } : {}),
      })
      .returning({ id: mcpInvocation.id });

    return row?.id ?? null;
  } catch (error) {
    // The same read is in flight. The next gather can retry.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

type HealthReadSettlement =
  | { kind: "succeeded"; resultProvenance: McpResultProvenance }
  | { kind: "failed"; lastError: string; resultProvenance?: McpResultProvenance };

async function settleHealthMcpRead(input: {
  userId: string;
  invocationId: string;
  settlement: HealthReadSettlement;
}): Promise<void> {
  const now = new Date();
  const settlement = input.settlement;
  const provenance = settlement.resultProvenance;

  // Always resolve: a read is safe to repeat, and no recovery UI can reach a row with no staging.
  await db()
    .update(mcpInvocation)
    .set({
      ...(provenance
        ? {
            attemptLifecycle: "response_received" as const,
            responseReceivedAt: now,
            resultProvenance: provenance,
          }
        : {}),
      effectOutcome: settlement.kind === "succeeded" ? "succeeded" : "failed",
      retryDisposition: "safe",
      resolvedAt: now,
      resolutionReason: `health_read_${settlement.kind}`,
      ...(settlement.kind !== "succeeded" ? { lastError: settlement.lastError } : {}),
    })
    .where(
      and(
        eq(mcpInvocation.id, input.invocationId),
        eq(mcpInvocation.userId, input.userId),
        eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
        isNull(mcpInvocation.effectOutcome),
        isNull(mcpInvocation.retryDisposition),
        isNull(mcpInvocation.resolvedAt),
      ),
    );
}

/** Settle the invocation and its staging row together. Only successors have a predecessor. */
async function settleMcpInvocationAggregate(input: {
  userId: string;
  invocationId: string;
  mode: "normal" | "successor";
  settlement: McpInvocationSettlement;
}): Promise<void> {
  await runAtomic(db(), async (tx) => {
    const now = new Date();
    const ambiguous = input.settlement.kind === "ambiguous";
    const succeeded = input.settlement.kind === "succeeded";

    const provenance =
      input.settlement.kind === "succeeded"
        ? input.settlement.resultProvenance
        : input.settlement.kind === "ambiguous"
          ? input.settlement.resultProvenance
          : undefined;

    const [updated] = await tx
      .update(mcpInvocation)
      .set({
        ...(provenance
          ? {
              attemptLifecycle: "response_received" as const,
              responseReceivedAt: now,
              resultProvenance: provenance,
            }
          : {}),
        effectOutcome: succeeded ? "succeeded" : ambiguous ? "unknown" : "failed",
        retryDisposition: ambiguous ? "blocked" : "safe",
        resolvedAt: ambiguous ? null : now,
        resolutionReason: input.settlement.kind,
        ...(input.settlement.kind === "ambiguous" || input.settlement.kind === "not_delivered"
          ? { lastError: input.settlement.lastError }
          : {}),
      })
      .where(
        and(
          eq(mcpInvocation.id, input.invocationId),
          eq(mcpInvocation.userId, input.userId),
          eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.retryDisposition),
          isNull(mcpInvocation.resolvedAt),
          input.mode === "successor"
            ? isNotNull(mcpInvocation.successorOf)
            : isNull(mcpInvocation.successorOf),
        ),
      )
      .returning({ stagingId: mcpInvocation.stagingId });

    const row = requireRow(updated, "settleMcpInvocationAggregate guarded invocation");

    if (!row.stagingId) {
      throw new Error("settleMcpInvocationAggregate received a health-read invocation");
    }

    const [staging] = await tx
      .update(actionStagings)
      .set({
        status: input.settlement.kind === "not_delivered" ? "failed" : "executed",
        outcome: succeeded ? "succeeded" : ambiguous ? "unknown" : "failed",
        executedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(
        and(
          eq(actionStagings.id, row.stagingId),
          eq(actionStagings.userId, input.userId),
          eq(actionStagings.outcome, "dispatching"),
        ),
      )
      .returning({ id: actionStagings.id });

    requireRow(staging, "settleMcpInvocationAggregate guarded staging");
  });
}

/** Durable proof that the provider phase ended, used only after settlement fails. */
async function markMcpSettlementIncomplete(input: PendingMcpSettlementRepair): Promise<boolean> {
  const [row] = await db()
    .select({ stagingId: mcpInvocation.stagingId })
    .from(mcpInvocation)
    .where(
      and(
        eq(mcpInvocation.id, input.invocationId),
        eq(mcpInvocation.userId, input.userId),
        inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
        isNull(mcpInvocation.effectOutcome),
        isNull(mcpInvocation.retryDisposition),
        isNull(mcpInvocation.resolvedAt),
      ),
    )
    .limit(1);

  if (!row) return true;

  if (!row.stagingId) return true;

  const [marked] = await db()
    .update(actionStagings)
    .set({
      status: "executed",
      outcome: "unknown",
      executedAt: sql`coalesce(${actionStagings.executedAt}, now())`,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
    })
    .where(
      and(
        eq(actionStagings.id, row.stagingId),
        eq(actionStagings.userId, input.userId),
        or(
          inArray(actionStagings.outcome, ["planned", "dispatching", "failed", "succeeded"]),
          isNull(actionStagings.outcome),
        ),
      ),
    )
    .returning({ id: actionStagings.id });

  if (marked) return true;

  const [alreadyMarked] = await db()
    .select({ id: actionStagings.id })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.id, row.stagingId),
        eq(actionStagings.userId, input.userId),
        eq(actionStagings.outcome, "unknown"),
      ),
    )
    .limit(1);

  return Boolean(alreadyMarked);
}

type ReservedMcpSuccessor = { invocation: McpInvocation; effectiveInput: unknown };

type ReservedMcpSuccessorSettlement = McpInvocationSettlement;

/**
 * Keep successor helpers unexported: the package export wildcard reaches this file.
 * `resumeReservedSuccessor` is the only public entry.
 */
async function readReservedMcpSuccessor(input: {
  userId: string;
  invocationId: string;
}): Promise<ReservedMcpSuccessor | undefined> {
  const [row] = await db()
    .select({
      invocation: mcpInvocation,
      proposedInput: actionStagings.proposedInput,
      decidedInput: actionStagings.decidedInput,
    })
    .from(mcpInvocation)
    .innerJoin(actionStagings, eq(actionStagings.id, mcpInvocation.stagingId))
    .where(
      and(
        eq(mcpInvocation.id, input.invocationId),
        eq(mcpInvocation.userId, input.userId),
        eq(actionStagings.userId, input.userId),
        isNotNull(mcpInvocation.successorOf),
      ),
    )
    .limit(1);

  return row
    ? { invocation: row.invocation, effectiveInput: row.decidedInput ?? row.proposedInput }
    : undefined;
}

/** Revalidate and claim a prepared successor in one transaction, under the connection row lock. */
async function claimReservedMcpSuccessorDelivery(input: {
  userId: string;
  invocationId: string;
  expectedCall: McpCallInput;
  liveDescriptorHash: string;
}): Promise<{ invocation: McpInvocation; call: McpCallInput } | undefined> {
  return runAtomic(db(), async (tx) => {
    const [lockedConnection] = await tx
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.id, input.expectedCall.connectionId),
          eq(mcpConnections.userId, input.userId),
        ),
      )
      .for("update");

    if (!lockedConnection) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP recovery connection changed before delivery.",
      );
    }

    const [invocation] = await tx
      .select()
      .from(mcpInvocation)
      .where(and(eq(mcpInvocation.id, input.invocationId), eq(mcpInvocation.userId, input.userId)))
      .for("update");

    if (
      !invocation ||
      invocation.attemptLifecycle !== "prepared" ||
      invocation.resolvedAt ||
      !invocation.successorOf ||
      !invocation.stagingId
    ) {
      return undefined;
    }

    const [staging] = await tx
      .select({
        proposedInput: actionStagings.proposedInput,
        decidedInput: actionStagings.decidedInput,
      })
      .from(actionStagings)
      .where(
        and(
          eq(actionStagings.id, invocation.stagingId),
          eq(actionStagings.userId, input.userId),
          eq(actionStagings.outcome, "dispatching"),
        ),
      )
      .for("update");

    if (!staging) {
      throw new McpClientError(
        "invalid_arguments",
        "Stored MCP recovery authorization is no longer dispatchable.",
      );
    }

    const parsed = mcpCallInput.safeParse(staging.decidedInput ?? staging.proposedInput);

    if (!parsed.success) {
      throw new McpClientError("invalid_arguments", "Stored MCP recovery input is invalid.");
    }

    const call = parsed.data;

    if (
      call.connectionId !== input.expectedCall.connectionId ||
      call.remoteName !== input.expectedCall.remoteName ||
      call.catalogRevision !== input.expectedCall.catalogRevision ||
      canonicalArgsHash(call.arguments) !== canonicalArgsHash(input.expectedCall.arguments) ||
      call.connectionId !== invocation.connectionId ||
      call.remoteName !== invocation.remoteName ||
      canonicalArgsHash(call.arguments) !== invocation.argsHash
    ) {
      throw new McpClientError("invalid_arguments", "Stored MCP recovery input has drifted.");
    }

    const identity = await resolveMcpToolIdentity(
      {
        userId: input.userId,
        connectionId: call.connectionId,
        remoteName: call.remoteName,
        catalogRevision: call.catalogRevision,
      },
      tx,
    );

    const liveEffectClass =
      identity.status === "resolved" ? identity.policy?.effectClass : undefined;

    if (
      identity.status !== "resolved" ||
      !identity.connection.currentCatalogRevisionId ||
      identity.connection.currentCatalogRevisionId !== invocation.catalogRevisionId ||
      identity.descriptorHash !== invocation.descriptorHash ||
      input.liveDescriptorHash !== invocation.descriptorHash ||
      (identity.policy?.policyRevision ?? null) !== invocation.policyRevision ||
      (liveEffectClass ?? "unknown") !== invocation.effectClass ||
      liveEffectClass === "read"
    ) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP recovery contract changed before delivery.",
      );
    }

    const [claimed] = await tx
      .update(mcpInvocation)
      .set({ attemptLifecycle: "delivery_possible", deliveryPossibleAt: new Date() })
      .where(
        and(
          eq(mcpInvocation.id, invocation.id),
          eq(mcpInvocation.userId, input.userId),
          eq(mcpInvocation.attemptLifecycle, "prepared"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.retryDisposition),
          isNull(mcpInvocation.resolvedAt),
          isNotNull(mcpInvocation.successorOf),
        ),
      )
      .returning();

    return claimed ? { invocation: claimed, call } : undefined;
  });
}

/** Settle both successor barriers only from the one unresolved delivery state. */
async function settleReservedMcpSuccessor(input: {
  userId: string;
  invocationId: string;
  settlement: ReservedMcpSuccessorSettlement;
}): Promise<void> {
  await settleMcpInvocationAggregate({ ...input, mode: "successor" });
}

/** Repair only rows with proof the provider phase ended. A live request stays `dispatching`. */
async function normalizeMarkedMcpSettlementFailure(
  input: PendingMcpSettlementRepair,
): Promise<boolean> {
  return runAtomic(db(), async (tx) => {
    const now = new Date();

    const [row] = await tx
      .select({ stagingId: mcpInvocation.stagingId })
      .from(mcpInvocation)
      .where(
        and(
          eq(mcpInvocation.id, input.invocationId),
          eq(mcpInvocation.userId, input.userId),
          inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.retryDisposition),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .for("update");

    if (!row) return true;

    if (!row.stagingId) return true;

    const [staging] = await tx
      .select({ outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(and(eq(actionStagings.id, row.stagingId), eq(actionStagings.userId, input.userId)))
      .for("update");

    if (!staging || staging.outcome !== "unknown") return false;

    const [updated] = await tx
      .update(mcpInvocation)
      .set({
        ...(input.resultProvenance
          ? {
              attemptLifecycle: "response_received" as const,
              responseReceivedAt: now,
              resultProvenance: input.resultProvenance,
            }
          : {}),
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        resolutionReason: "settlement_incomplete",
        lastError: "Alfred could not record the final MCP disposition after delivery.",
      })
      .where(
        and(
          eq(mcpInvocation.id, input.invocationId),
          eq(mcpInvocation.userId, input.userId),
          inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.retryDisposition),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id });

    return Boolean(updated);
  });
}

async function repairMcpSettlement(input: PendingMcpSettlementRepair): Promise<boolean> {
  if (!(await markMcpSettlementIncomplete(input))) return false;

  return normalizeMarkedMcpSettlementFailure(input);
}

export class McpExecutionBroker {
  readonly #manager: McpConnectionManager;

  /** Per instance, so a swapped test broker gets a fresh queue. Capacity counts all users together. */
  readonly #pendingRepairs = new Map<string, PendingMcpSettlementRepair>();
  #activeSettlementSlots = 0;
  #repairDrainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(manager: McpConnectionManager) {
    this.#manager = manager;
  }

  /** Retry one batch of queued settlement repairs. Never calls a provider; boot covers a crash. */
  async drainPendingSettlementRepairs(): Promise<{ repaired: number; remaining: number }> {
    if (this.#repairDrainTimer) {
      clearTimeout(this.#repairDrainTimer);
      this.#repairDrainTimer = undefined;
    }

    let repaired = 0;

    for (const [key, repair] of [...this.#pendingRepairs].slice(
      0,
      MCP_SETTLEMENT_REPAIR_BATCH_SIZE,
    )) {
      let done = false;

      try {
        done = await repairMcpSettlement(repair);
      } catch {
        done = false;
      }

      this.#pendingRepairs.delete(key);

      if (done) {
        repaired += 1;
        continue;
      }

      // Re-queue at the back so one failing row cannot starve the rest.
      this.#pendingRepairs.set(key, repair);
    }

    if (this.#pendingRepairs.size > 0) this.#scheduleRepairDrain();

    return { repaired, remaining: this.#pendingRepairs.size };
  }

  #scheduleRepairDrain(): void {
    if (this.#repairDrainTimer) return;

    const timer = setTimeout(() => {
      this.#repairDrainTimer = undefined;
      void this.drainPendingSettlementRepairs();
    }, MCP_SETTLEMENT_REPAIR_RETRY_MS);

    // Never hold the process open; boot covers what a shutdown leaves.
    unrefTimer(timer);
    this.#repairDrainTimer = timer;
  }

  /** One slot per effectful send or successor resume. Reads take none. */
  #acquireSettlementSlot(): () => void {
    if (
      !hasMcpBrokerAdmissionCapacity({
        pendingRepairs: this.#pendingRepairs.size,
        activeSettlements: this.#activeSettlementSlots,
      })
    ) {
      throw new McpClientError(
        "admission_full",
        "MCP execution is at capacity; try again in a moment.",
      );
    }

    this.#activeSettlementSlots += 1;
    let released = false;

    return () => {
      if (released) return;
      released = true;
      this.#activeSettlementSlots -= 1;
    };
  }

  async #bestEffortRepair(input: PendingMcpSettlementRepair): Promise<void> {
    this.#pendingRepairs.set(pendingRepairKey(input), input);

    try {
      if (await repairMcpSettlement(input)) {
        this.#pendingRepairs.delete(pendingRepairKey(input));

        return;
      }
    } catch {
      // The request must still return an ambiguous envelope.
    }

    // The drain retries this local-only repair; boot reconciliation covers a crash.
    this.#scheduleRepairDrain();
  }

  /** Check ownership, load the live catalog, and compare the live descriptor with the stored one. */
  async #prepareCall(input: {
    userId: string;
    ref: ExternalToolRef;
    signal?: AbortSignal;
    trace: McpTraceContext;
  }): Promise<PreparedMcpCall> {
    let identity = await resolveMcpToolIdentity({
      userId: input.userId,
      connectionId: input.ref.connectionId,
      remoteName: input.ref.remoteName,
      catalogRevision: input.ref.catalogRevision,
    });

    if (!identity.connection) {
      throw new McpClientError(
        "not_connected",
        `No connected MCP server '${input.ref.connectionId}'.`,
      );
    }

    const prepared = await this.#manager.prepareToolCall(
      input.ref.connectionId,
      input.signal,
      input.trace,
    );

    if (prepared.catalog.revision !== input.ref.catalogRevision) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP catalog changed after this tool was selected; refresh and reselect it",
      );
    }

    // A catalog publication can race the first read, so resolve again after loading.
    if (identity.status === "unresolved") {
      identity = await resolveMcpToolIdentity({
        userId: input.userId,
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        catalogRevision: input.ref.catalogRevision,
      });
    }

    const connection = identity.connection;

    if (!connection) {
      throw new McpClientError(
        "not_connected",
        `No connected MCP server '${input.ref.connectionId}'.`,
      );
    }

    const liveTool = prepared.catalog.tools.find((tool) => tool.name === input.ref.remoteName);

    return {
      identity,
      connection,
      prepared,
      descriptorHash: liveTool ? descriptorHash(liveTool) : undefined,
    };
  }

  /** Run an owner-approved health read. Stored and live descriptors must both say read-only. */
  async callHealthRead(input: McpHealthReadInput): Promise<McpCallEnvelope | null> {
    const span = startMcpTraceSpan({
      name: "runtime.mcp.health_read",
      ...(input.traceId ? { traceId: input.traceId } : {}),
      metadata: {
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        mappingRevision: input.mappingRevision,
      },
    });

    try {
      let definition = await readHealthMapping(input);

      if (!definition) {
        span.end({ status: "unavailable" });

        return null;
      }

      const resolved = await this.#prepareCall({
        userId: input.userId,
        ref: input.ref,
        ...(input.signal ? { signal: input.signal } : {}),
        trace: span.context,
      });

      // The owner may change the mapping during catalog load, so read it again.
      definition = await readHealthMapping(input);

      if (!definition) {
        span.end({ status: "unavailable" });

        return null;
      }

      if (resolved.identity.status !== "resolved") {
        throw new McpClientError(
          "catalog_stale",
          "The MCP health mapping no longer resolves to a current descriptor",
        );
      }

      const liveTool = resolved.prepared.catalog.tools.find(
        (tool) => tool.name === input.ref.remoteName,
      );

      const readOnly =
        isReadOnlyMcpToolIdentity(resolved.identity) &&
        resolved.identity.descriptorHash === input.descriptorHash &&
        resolved.descriptorHash === input.descriptorHash &&
        liveTool?.annotations?.readOnlyHint === true;

      if (!readOnly) {
        throw new McpClientError(
          "write_tool",
          "MCP health reads require an exact descriptor that asserts readOnlyHint=true",
        );
      }

      // A reviewed `high` policy demands approval, which this read cannot ask for, so stop.
      // A missing policy is fine: the health mapping is itself an owner review.
      if (resolved.identity.policy?.riskTier === "high") {
        span.end({ status: "blocked", metadata: { riskTier: "high" } });

        return null;
      }

      // Tracing only. This decision grants nothing here.
      const riskTier = effectiveMcpRiskTier(resolved.identity);

      const invocationId = await reserveHealthMcpRead({
        userId: input.userId,
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        catalogRevisionId: resolved.connection.currentCatalogRevisionId,
        descriptorHash: input.descriptorHash,
        policyRevision: resolved.identity.policy?.policyRevision,
        arguments: definition.arguments,
        traceId: input.traceId,
      });

      if (!invocationId) {
        span.end({ status: "blocked", metadata: { riskTier } });

        return null;
      }

      let envelope: McpCallEnvelope;

      try {
        envelope = await resolved.prepared.call(input.ref, definition.arguments, {
          ...(input.signal ? { signal: input.signal } : {}),
          trace: span.context,
        });
      } catch (error) {
        const provenance = error instanceof McpClientError ? error.provenance : undefined;

        const settlement: HealthReadSettlement = {
          kind: "failed",
          lastError: boundedMcpErrorText(error),
          ...(provenance ? { resultProvenance: provenance } : {}),
        };

        await settleHealthMcpRead({
          userId: input.userId,
          invocationId,
          settlement,
        });

        if (isProvenNotDelivered(error)) throw error;

        span.end({ status: "failed", metadata: { riskTier } });

        return null;
      }

      if (envelope.outcome !== "completed") {
        await settleHealthMcpRead({
          userId: input.userId,
          invocationId,
          settlement: {
            kind: "failed",
            lastError: "MCP health read returned a tool error",
            resultProvenance: envelope.provenance,
          },
        });

        span.end({ status: "tool_error", metadata: { riskTier } });

        return null;
      }

      await settleHealthMcpRead({
        userId: input.userId,
        invocationId,
        settlement: { kind: "succeeded", resultProvenance: envelope.provenance },
      });

      span.end({ status: "completed", metadata: { riskTier } });

      return envelope;
    } catch (error) {
      span.end({ status: "error", level: "ERROR" });
      throw error;
    }
  }

  /** Reads skip the barrier; `write`/`unknown` calls reserve one before sending. */
  async callTool(input: McpBrokerCallInput): Promise<McpBrokerOutcome> {
    const span = startMcpTraceSpan({
      name: "runtime.mcp.broker_invoke",
      ...(input.traceId ? { traceId: input.traceId } : {}),
      metadata: {
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        stagingId: input.stagingId,
      },
    });

    try {
      const outcome = await this.#callTool(input, span.context);
      span.end({
        status: outcome.status,
        metadata: {
          invocationId:
            "invocationId" in outcome ? outcome.invocationId : outcome.priorInvocationId,
        },
      });

      return outcome;
    } catch (error) {
      span.end({ status: "error", level: "ERROR" });
      throw error;
    }
  }

  /** Send a host-reserved successor by id. The atomic `prepared` claim makes it send once. */
  async resumeReservedSuccessor(input: McpReservedSuccessorInput): Promise<McpBrokerOutcome> {
    const releaseSettlementSlot = this.#acquireSettlementSlot();

    try {
      return await this.#resumeReservedSuccessor(input);
    } finally {
      releaseSettlementSlot();
    }
  }

  async #resumeReservedSuccessor(input: McpReservedSuccessorInput): Promise<McpBrokerOutcome> {
    const reserved = await readReservedMcpSuccessor(input);

    if (!reserved) {
      throw new McpClientError("not_connected", "MCP recovery operation was not found.");
    }

    if (reserved.invocation.attemptLifecycle !== "prepared" || reserved.invocation.resolvedAt) {
      return {
        status: "blocked",
        reason: "already_recorded",
        message: BLOCKED_RECORDED_MESSAGE,
        priorInvocationId: reserved.invocation.id,
      };
    }

    const parsed = mcpCallInput.safeParse(reserved.effectiveInput);

    if (!parsed.success) {
      throw new McpClientError("invalid_arguments", "Stored MCP recovery input is invalid.");
    }

    const call = parsed.data;
    const invocation = reserved.invocation;

    if (
      call.connectionId !== invocation.connectionId ||
      call.remoteName !== invocation.remoteName ||
      canonicalArgsHash(call.arguments) !== invocation.argsHash
    ) {
      throw new McpClientError("invalid_arguments", "Stored MCP recovery input has drifted.");
    }

    const identity = await resolveMcpToolIdentity({
      userId: input.userId,
      connectionId: call.connectionId,
      remoteName: call.remoteName,
      catalogRevision: call.catalogRevision,
    });

    if (identity.status !== "resolved" || !identity.connection.currentCatalogRevisionId) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP tool changed after this recovery was authorized.",
      );
    }

    // No caller signal reaches this path (see `McpReservedSuccessorInput`).
    const prepared = await this.#manager.prepareToolCall(call.connectionId);
    const liveTool = prepared.catalog.tools.find((tool) => tool.name === call.remoteName);
    const liveDescriptorHash = liveTool ? descriptorHash(liveTool) : undefined;
    const liveEffectClass = identity.policy?.effectClass ?? "unknown";

    if (
      prepared.catalog.revision !== call.catalogRevision ||
      identity.connection.currentCatalogRevisionId !== invocation.catalogRevisionId ||
      identity.descriptorHash !== invocation.descriptorHash ||
      liveDescriptorHash !== invocation.descriptorHash ||
      (identity.policy?.policyRevision ?? null) !== invocation.policyRevision ||
      liveEffectClass !== invocation.effectClass ||
      liveEffectClass === "read"
    ) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP recovery contract changed before delivery.",
      );
    }

    if (!liveDescriptorHash) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP recovery contract changed before delivery.",
      );
    }

    const claimed = await claimReservedMcpSuccessorDelivery({
      ...input,
      expectedCall: call,
      liveDescriptorHash,
    });

    if (!claimed) {
      return {
        status: "blocked",
        reason: "already_recorded",
        message: BLOCKED_RECORDED_MESSAGE,
        priorInvocationId: invocation.id,
      };
    }

    const ref: ExternalToolRef = {
      kind: "mcp",
      connectionId: claimed.call.connectionId,
      remoteName: claimed.call.remoteName,
      catalogRevision: claimed.call.catalogRevision,
    };

    const trace = startMcpTraceSpan({
      name: "runtime.mcp.broker_invoke",
      metadata: {
        invocationId: claimed.invocation.id,
        successorOf: claimed.invocation.successorOf,
        recovery: true,
      },
    });

    let envelope: McpCallEnvelope;

    try {
      envelope = await prepared.call(ref, claimed.call.arguments, { trace: trace.context });
    } catch (err) {
      if (isProvenNotDelivered(err)) {
        try {
          await settleReservedMcpSuccessor({
            userId: input.userId,
            invocationId: claimed.invocation.id,
            settlement: { kind: "not_delivered", lastError: boundedMcpErrorText(err) },
          });
        } catch {
          await this.#bestEffortRepair({
            userId: input.userId,
            invocationId: claimed.invocation.id,
          });
          trace.end({ status: "ambiguous", level: "ERROR" });

          return {
            status: "ambiguous",
            invocationId: claimed.invocation.id,
            message: AMBIGUOUS_MESSAGE,
          };
        }

        trace.end({ status: "error", level: "ERROR" });
        throw err;
      }

      const provenance = err instanceof McpClientError ? err.provenance : undefined;

      try {
        await settleReservedMcpSuccessor({
          userId: input.userId,
          invocationId: claimed.invocation.id,
          settlement: {
            kind: "ambiguous",
            lastError: boundedMcpErrorText(err),
            ...(provenance ? { resultProvenance: provenance } : {}),
          },
        });
      } catch {
        await this.#bestEffortRepair({
          userId: input.userId,
          invocationId: claimed.invocation.id,
          ...(provenance ? { resultProvenance: provenance } : {}),
        });
      }

      trace.end({ status: "ambiguous", level: "ERROR" });

      return {
        status: "ambiguous",
        invocationId: claimed.invocation.id,
        message: AMBIGUOUS_MESSAGE,
      };
    }

    try {
      await settleReservedMcpSuccessor({
        userId: input.userId,
        invocationId: claimed.invocation.id,
        settlement:
          envelope.outcome === "completed"
            ? { kind: "succeeded", resultProvenance: envelope.provenance }
            : {
                kind: "ambiguous",
                lastError: MCP_TOOL_ERROR_MESSAGE,
                resultProvenance: envelope.provenance,
              },
      });
    } catch {
      await this.#bestEffortRepair({
        userId: input.userId,
        invocationId: claimed.invocation.id,
        resultProvenance: envelope.provenance,
      });
      trace.end({ status: "ambiguous", level: "ERROR" });

      return {
        status: "ambiguous",
        invocationId: claimed.invocation.id,
        message: AMBIGUOUS_MESSAGE,
      };
    }

    const outcome: McpBrokerOutcome =
      envelope.outcome === "completed"
        ? { status: "completed", invocationId: claimed.invocation.id, envelope }
        : {
            status: "ambiguous",
            invocationId: claimed.invocation.id,
            message: AMBIGUOUS_MESSAGE,
          };

    trace.end({ status: outcome.status });

    return outcome;
  }

  async #callTool(input: McpBrokerCallInput, trace: McpTraceContext): Promise<McpBrokerOutcome> {
    const { ref } = input;

    const preparedCall = await this.#prepareCall({
      userId: input.userId,
      ref,
      ...(input.signal ? { signal: input.signal } : {}),
      trace,
    });

    const { identity, connection, prepared, descriptorHash: hash } = preparedCall;

    // Use the policy only if the live descriptor hash matches; otherwise `unknown`.
    const policy =
      identity.status === "resolved" && hash === identity.descriptorHash
        ? identity.policy
        : undefined;

    const effectClass: McpEffectClass = policy?.effectClass ?? "unknown";

    if (effectClass === "read") {
      // Reads skip the barrier. A completed read gets an audit row for provenance.
      const envelope = await prepared.call(ref, input.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
        trace,
      });

      const invocationId =
        envelope.outcome === "completed" && policy
          ? await recordCompletedMcpRead({
              userId: input.userId,
              stagingId: input.stagingId,
              connectionId: ref.connectionId,
              remoteName: ref.remoteName,
              catalogRevisionId: connection.currentCatalogRevisionId,
              descriptorHash: hash,
              policyRevision: policy.policyRevision,
              arguments: input.arguments,
              resultProvenance: envelope.provenance,
            })
          : null;

      return {
        status: envelope.outcome === "completed" ? "completed" : "tool_error",
        invocationId,
        envelope,
      };
    }

    return this.#callEffectful(input, {
      effectClass,
      descriptorHashValue: hash,
      policy,
      connection,
      prepared,
      trace,
    });
  }

  async #callEffectful(
    input: McpBrokerCallInput,
    resolved: {
      effectClass: McpEffectClass;
      descriptorHashValue: string | undefined;
      policy: McpToolPolicyRow | undefined;
      /** The owner-verified durable pointer already read in `callTool`. */
      connection: OwnedMcpConnectionRef;
      prepared: McpPreparedToolCall;
      trace: McpTraceContext;
    },
  ): Promise<McpBrokerOutcome> {
    const releaseSettlementSlot = this.#acquireSettlementSlot();

    try {
      return await this.#reserveAndDeliver(input, resolved);
    } finally {
      releaseSettlementSlot();
    }
  }

  async #reserveAndDeliver(
    input: McpBrokerCallInput,
    resolved: {
      effectClass: McpEffectClass;
      descriptorHashValue: string | undefined;
      policy: McpToolPolicyRow | undefined;
      connection: OwnedMcpConnectionRef;
      prepared: McpPreparedToolCall;
      trace: McpTraceContext;
    },
  ): Promise<McpBrokerOutcome> {
    const { ref } = input;
    const argsHash = canonicalArgsHash(input.arguments);
    const connection = resolved.connection;

    // The row is the barrier: a partial unique index refuses an identical unresolved call.
    const minted = await reserveNormalMcpInvocationDelivery({
      stagingId: input.stagingId,
      userId: input.userId,
      connectionId: ref.connectionId,
      remoteName: ref.remoteName,
      argsHash,
      effectClass: resolved.effectClass,
      // Omit absent keys: Drizzle binds NULL for an undefined key but DEFAULT for a missing one.
      ...(connection?.currentCatalogRevisionId
        ? { catalogRevisionId: connection.currentCatalogRevisionId }
        : {}),
      ...(resolved.descriptorHashValue ? { descriptorHash: resolved.descriptorHashValue } : {}),
      ...(resolved.policy ? { policyRevision: resolved.policy.policyRevision } : {}),
      // Trace ids come from the staging row inside `reserveNormalMcpInvocationDelivery`.
    });

    if (!minted.ok) {
      return this.#resolveBlocked(input, argsHash, minted.reason);
    }

    const invocation = minted.invocation;

    // Persist `delivery_possible` before sending, so a crash leaves proof of ambiguity.
    // Invariant: from here no layer may re-send this `tools/call` (SDK retry is off
    // via `maxTotalTimeout`). Only a reserved recovery successor may send again.
    try {
      const envelope = await resolved.prepared.call(ref, input.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
        trace: resolved.trace,
      });

      return this.#resolveResponse(invocation, envelope);
    } catch (err) {
      if (isProvenNotDelivered(err)) {
        // Never delivered: resolve as not-delivered and rethrow.
        try {
          await settleMcpInvocationAggregate({
            mode: "normal",
            invocationId: invocation.id,
            userId: input.userId,
            settlement: { kind: "not_delivered", lastError: boundedMcpErrorText(err) },
          });
        } catch {
          await this.#bestEffortRepair({
            userId: input.userId,
            invocationId: invocation.id,
          });

          return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
        }

        throw err;
      }

      // Possibly delivered: leave the row unresolved so the barrier holds.
      // If a malformed response arrived (`invalid_output`), store its provenance
      // and move to `response_received`. The outcome stays ambiguous.
      const provenance = err instanceof McpClientError ? err.provenance : undefined;

      try {
        await settleMcpInvocationAggregate({
          mode: "normal",
          invocationId: invocation.id,
          userId: input.userId,
          settlement: {
            kind: "ambiguous",
            lastError: boundedMcpErrorText(err),
            ...(provenance ? { resultProvenance: provenance } : {}),
          },
        });
      } catch {
        await this.#bestEffortRepair({
          userId: input.userId,
          invocationId: invocation.id,
          ...(provenance ? { resultProvenance: provenance } : {}),
        });
      }

      return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
    }
  }

  /** Only a confirmed success resolves an effectful call. */
  async #resolveResponse(
    invocation: McpInvocation,
    envelope: McpCallEnvelope,
  ): Promise<McpBrokerOutcome> {
    if (envelope.outcome === "tool_error") {
      // `isError` does not prove the tool had no effect, so the barrier stays.
      try {
        await settleMcpInvocationAggregate({
          mode: "normal",
          invocationId: invocation.id,
          userId: invocation.userId,
          settlement: {
            kind: "ambiguous",
            lastError: MCP_TOOL_ERROR_MESSAGE,
            resultProvenance: envelope.provenance,
          },
        });
      } catch {
        await this.#bestEffortRepair({
          userId: invocation.userId,
          invocationId: invocation.id,
          resultProvenance: envelope.provenance,
        });
      }

      return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
    }

    try {
      await settleMcpInvocationAggregate({
        mode: "normal",
        invocationId: invocation.id,
        userId: invocation.userId,
        settlement: { kind: "succeeded", resultProvenance: envelope.provenance },
      });
    } catch {
      await this.#bestEffortRepair({
        userId: invocation.userId,
        invocationId: invocation.id,
        resultProvenance: envelope.provenance,
      });

      return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
    }

    return { status: "completed", invocationId: invocation.id, envelope };
  }

  /**
   * `barrier`: another staging row holds an unresolved match.
   * `duplicate_staging`: this row was already recorded; read it, never re-send.
   */
  async #resolveBlocked(
    input: McpBrokerCallInput,
    argsHash: string,
    reason: "barrier" | "duplicate_staging",
  ): Promise<McpBrokerOutcome> {
    if (reason === "duplicate_staging") {
      const prior = await readInvocationByStagingId(input.stagingId);

      if (prior && prior.resolvedAt === null && prior.attemptLifecycle !== "prepared") {
        return {
          status: "ambiguous",
          invocationId: prior.id,
          message: BLOCKED_RECORDED_MESSAGE,
        };
      }

      return {
        status: "blocked",
        reason: "already_recorded",
        message: BLOCKED_RECORDED_MESSAGE,
        priorInvocationId: prior?.id ?? null,
      };
    }

    const blocking = await findUnresolvedBarrier({
      userId: input.userId,
      connectionId: input.ref.connectionId,
      remoteName: input.ref.remoteName,
      argsHash,
    });

    return {
      status: "blocked",
      reason: "ambiguity_barrier",
      message: BLOCKED_BARRIER_MESSAGE,
      priorInvocationId: blocking?.id ?? null,
    };
  }
}
