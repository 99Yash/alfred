/**
 * MCP execution broker (PRD #540) — the durable trust boundary around a single
 * `tools/call`. It composes the already-built pieces (connection manager +
 * persistence ledger + hashing) into the one operation the dispatch seam invokes:
 * route an authorized `mcp.call` through the ambiguity ledger and return a
 * structured, model-safe outcome.
 *
 * The broker owns the durable semantics the raw client deliberately does NOT:
 *  - reviewed effect/retry policy resolution (drift → conservative `unknown`);
 *  - the pre-dispatch barrier reservation that stops a possibly-delivered write
 *    from being silently repeated (docs/research/mcp-ambiguous-write-outcomes.md);
 *  - the crash-safe lifecycle (`prepared` → `delivery_possible` →
 *    `response_received`) that lets the boot reconcile sweep classify a mid-flight
 *    crash (issue #540 clarification #1);
 *  - the boundary-based ambiguity rule (any *possibly-delivered* failure resolves
 *    to `unknown`/blocked, not just timeouts — clarification #2).
 *
 * It is proven OFFLINE: the connection manager injects a fake protocol, so
 * connect → refresh → call runs with no socket. Successor reservation stays
 * host-owned in `recovery.ts`; the broker never mints a successor from a model
 * proposal (clarification #4).
 */

import {
  mcpCallInput,
  type McpCallInput,
  type McpEffectClass,
  type McpResultProvenance,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { requireRow, runAtomic } from "@alfred/db/helpers";
import {
  actionStagings,
  mcpConnections,
  mcpInvocation,
  type McpInvocation,
  type McpToolPolicyRow,
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
  blockMcpInvocationAsAmbiguous,
  findUnresolvedBarrier,
  markMcpInvocationDeliveryPossible,
  readInvocationByStagingId,
  reserveMcpInvocation,
  resolveMcpToolIdentity,
  settleMcpInvocationNotDelivered,
  settleMcpInvocationSucceeded,
  type OwnedMcpConnectionRef,
} from "./invocations";

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
  /** Opaque MCP arguments — validated against the exact tool schema by the raw client. */
  arguments: unknown;
  /** Run trace id. Observability only; ledger correlation still copies the staging row. */
  traceId?: string;
  signal?: AbortSignal;
}

export interface McpReservedSuccessorInput {
  userId: string;
  invocationId: string;
  signal?: AbortSignal;
}

export type McpBrokerBlockReason = "ambiguity_barrier" | "already_recorded";

/**
 * The broker's structured, non-throwing outcomes. Deterministic pre-delivery
 * failures (an invalid call, stale catalog, dead connection) are NOT represented
 * here — those THROW out of the broker so the dispatch seam records a normal
 * `failed` staging row. These four are the outcomes that must ride durably in the
 * `execute_result` envelope instead:
 *
 *  - `completed`: a clean successful response was received.
 *  - `tool_error`: an idempotent read reported an MCP tool error.
 *  - `blocked`: the barrier refused the reservation; NOTHING was dispatched.
 *  - `ambiguous`: a possibly-delivered failure or an effectful MCP tool error;
 *    the write may have happened and the ledger row stays unresolved so an
 *    identical repeat keeps being blocked.
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

/** True only for a deterministic pre-delivery `McpClientError` (provably not delivered). */
function isProvenNotDelivered(err: unknown): boolean {
  return err instanceof McpClientError && isPreDeliveryErrorCode(err.code);
}

type ReservedMcpSuccessor = { invocation: McpInvocation; effectiveInput: unknown };

type ReservedMcpSuccessorSettlement =
  | { kind: "succeeded"; resultProvenance: McpResultProvenance }
  | { kind: "not_delivered"; lastError: string }
  | {
      kind: "ambiguous";
      lastError: string;
      resultProvenance?: McpResultProvenance;
    };

/**
 * Module-private successor state. The package export wildcard can reach this
 * file, so raw read/claim/settle operations must not be exported from any leaf.
 * The class's ID-only `resumeReservedSuccessor` method is the sole product door.
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

/**
 * Revalidate and claim a prepared successor in one authority-locked transaction.
 * The connection row serializes catalog-pointer, ownership, and policy changes.
 * The invocation/staging locks bind the exact persisted input to the transition.
 */
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
      !invocation.successorOf
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
        ...(ambiguous && provenance
          ? {
              attemptLifecycle: "response_received" as const,
              responseReceivedAt: now,
              resultProvenance: provenance,
            }
          : succeeded
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
          isNotNull(mcpInvocation.successorOf),
        ),
      )
      .returning({ stagingId: mcpInvocation.stagingId });
    const row = requireRow(updated, "settleReservedMcpSuccessor guarded invocation");
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
    requireRow(staging, "settleReservedMcpSuccessor guarded staging");
  });
}

/**
 * A remote response exists, but the first local settlement did not commit.
 * Convert only that claimed successor into the normal recovery state. This is a
 * local database repair and must never call the MCP provider.
 */
async function normalizeReservedMcpSuccessorSettlementFailure(input: {
  userId: string;
  invocationId: string;
  resultProvenance: McpResultProvenance;
}): Promise<boolean> {
  return runAtomic(db(), async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(mcpInvocation)
      .set({
        attemptLifecycle: "response_received",
        responseReceivedAt: now,
        resultProvenance: input.resultProvenance,
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        resolutionReason: "settlement_incomplete",
        lastError: "Alfred received a response but could not record its final disposition.",
      })
      .where(
        and(
          eq(mcpInvocation.id, input.invocationId),
          eq(mcpInvocation.userId, input.userId),
          eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.retryDisposition),
          isNull(mcpInvocation.resolvedAt),
          isNotNull(mcpInvocation.successorOf),
        ),
      )
      .returning({ stagingId: mcpInvocation.stagingId });
    if (!updated) return false;

    const [staging] = await tx
      .select({ outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(and(eq(actionStagings.id, updated.stagingId), eq(actionStagings.userId, input.userId)))
      .for("update");
    const stagingRow = requireRow(
      staging,
      "normalizeReservedMcpSuccessorSettlementFailure staging",
    );
    if (stagingRow.outcome === "unknown") return true;
    const [aligned] = await tx
      .update(actionStagings)
      .set({
        status: "executed",
        outcome: "unknown",
        executedAt: sql`coalesce(${actionStagings.executedAt}, now())`,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(
        and(
          eq(actionStagings.id, updated.stagingId),
          eq(actionStagings.userId, input.userId),
          or(
            inArray(actionStagings.outcome, ["planned", "dispatching"]),
            isNull(actionStagings.outcome),
          ),
        ),
      )
      .returning({ id: actionStagings.id });
    requireRow(aligned, "normalizeReservedMcpSuccessorSettlementFailure guarded staging");
    return true;
  });
}

export class McpExecutionBroker {
  readonly #manager: McpConnectionManager;

  constructor(manager: McpConnectionManager) {
    this.#manager = manager;
  }

  /**
   * Route one authorized `mcp.call` through the ledger. Reads bypass the ledger
   * entirely (idempotent); effectful (`write`/`unknown`) calls mint a barrier
   * reservation BEFORE dispatch and resolve the lifecycle around the network hop.
   */
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

  /**
   * Deliver one host-reserved successor. The caller supplies only its durable id;
   * target and arguments are reloaded from the exact staging row. The atomic
   * `prepared` claim is the send-once gate for concurrent or repeated HTTP posts.
   */
  async resumeReservedSuccessor(input: McpReservedSuccessorInput): Promise<McpBrokerOutcome> {
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
    const prepared = await this.#manager.prepareToolCall(call.connectionId, input.signal);
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
      envelope = await prepared.call(ref, claimed.call.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
        trace: trace.context,
      });
    } catch (err) {
      if (isProvenNotDelivered(err)) {
        await settleReservedMcpSuccessor({
          userId: input.userId,
          invocationId: claimed.invocation.id,
          settlement: { kind: "not_delivered", lastError: boundedMcpErrorText(err) },
        });
        trace.end({ status: "error", level: "ERROR" });
        throw err;
      }
      const provenance = err instanceof McpClientError ? err.provenance : undefined;
      await settleReservedMcpSuccessor({
        userId: input.userId,
        invocationId: claimed.invocation.id,
        settlement: {
          kind: "ambiguous",
          lastError: boundedMcpErrorText(err),
          ...(provenance ? { resultProvenance: provenance } : {}),
        },
      });
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
    } catch (error) {
      let normalized = false;
      try {
        normalized = await normalizeReservedMcpSuccessorSettlementFailure({
          userId: input.userId,
          invocationId: claimed.invocation.id,
          resultProvenance: envelope.provenance,
        });
      } catch {
        // Preserve the original settlement failure. Boot reconciliation remains
        // the last-resort local repair if even this guarded normalization cannot
        // commit.
      }
      if (normalized) {
        trace.end({ status: "ambiguous", level: "ERROR" });
        return {
          status: "ambiguous",
          invocationId: claimed.invocation.id,
          message: AMBIGUOUS_MESSAGE,
        };
      }
      trace.end({ status: "error", level: "ERROR" });
      throw error;
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

    // Ownership is Alfred's trust boundary: an outbound effect must land only on a
    // connection the CALLING user owns. A model-proposed `connectionId` that is
    // absent — or owned by another user — is indistinguishable from "not
    // connected", the same scope `listMcpToolsLocal` enforces on the read half.
    // This runs BEFORE any client connect or ledger row: an ownership miss provably
    // predates any `tools/call`, so it throws a deterministic pre-delivery error
    // (no barrier minted) and the dispatch seam records an ordinary failure. It is
    // enforced here, at the read, rather than left as a convention for multi-user.
    let identity = await resolveMcpToolIdentity({
      userId: input.userId,
      connectionId: ref.connectionId,
      remoteName: ref.remoteName,
      catalogRevision: ref.catalogRevision,
    });
    if (!identity.connection) {
      throw new McpClientError("not_connected", `No connected MCP server '${ref.connectionId}'.`);
    }

    // Connecting/refreshing the catalog is a prerequisite, not the tool-call
    // delivery boundary: a failure here provably predates any `tools/call`, so it
    // throws (deterministic failure) with no ledger row minted. The manager reads
    // the mutable connection row again before first-use hydration: the identity
    // resolver proves ownership and policy, but its endpoint/credential snapshot
    // must not outlive a concurrent connection update.
    const prepared = await this.#manager.prepareToolCall(ref.connectionId, input.signal, trace);
    if (prepared.catalog.revision !== ref.catalogRevision) {
      throw new McpClientError(
        "catalog_stale",
        "The MCP catalog changed after this tool was selected; refresh and reselect it",
      );
    }
    if (identity.status === "unresolved") {
      identity = await resolveMcpToolIdentity({
        userId: input.userId,
        connectionId: ref.connectionId,
        remoteName: ref.remoteName,
        catalogRevision: ref.catalogRevision,
      });
    }
    const connection = identity.connection;
    if (!connection) {
      throw new McpClientError("not_connected", `No connected MCP server '${ref.connectionId}'.`);
    }

    // The durable identity and reviewed policy were resolved together above.
    // Honor that policy only if the exact live descriptor has the same hash. A
    // stale selection, missing live tool, or persisted/live drift therefore has
    // no policy and defaults to conservative `unknown`.
    const liveTool = prepared.catalog.tools.find((tool) => tool.name === ref.remoteName);
    const hash = liveTool ? descriptorHash(liveTool) : undefined;
    const policy =
      identity.status === "resolved" && hash === identity.descriptorHash
        ? identity.policy
        : undefined;
    const effectClass: McpEffectClass = policy?.effectClass ?? "unknown";

    if (effectClass === "read") {
      // Reads are idempotent: no barrier, no ledger row. Any failure (including a
      // possibly-delivered one) is safe to surface and re-run, so it just throws.
      // The options object IS the conditional — a spread inside a fresh literal
      // would just be a redundant copy (oxlint's `no-useless-spread`).
      const envelope = await prepared.call(ref, input.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
        trace,
      });
      return {
        status: envelope.outcome === "completed" ? "completed" : "tool_error",
        invocationId: null,
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
    const { ref } = input;
    const argsHash = canonicalArgsHash(input.arguments);
    // Only the current-revision POINTER is needed for the ledger row, and the
    // owner-verified connection pointer was already read in `callTool`, so reuse
    // it rather than fetching the catalog-sized revision row just to recover its
    // id.
    const connection = resolved.connection;

    // The reservation. Minting the row IS the barrier: the partial unique index
    // rejects a second unresolved proposal identical to an in-flight/blocked one.
    const minted = await reserveMcpInvocation({
      stagingId: input.stagingId,
      userId: input.userId,
      connectionId: ref.connectionId,
      remoteName: ref.remoteName,
      argsHash,
      effectClass: resolved.effectClass,
      // Conditional spread, like everywhere else in this repo — `exactOptionalPropertyTypes`
      // is off (#552), so a plain `key: maybeUndefined` is unenforced style rather than a
      // typed distinction. Here the distinction is also load-bearing: drizzle's insert walks
      // `Object.keys`, so a present-but-undefined key binds a NULL param where an absent key
      // emits `DEFAULT`. Same row today (all three columns are nullable with no default), but
      // the divergence would be silent the moment one of them gains a column default.
      ...(connection?.currentCatalogRevisionId
        ? { catalogRevisionId: connection.currentCatalogRevisionId }
        : {}),
      ...(resolved.descriptorHashValue ? { descriptorHash: resolved.descriptorHashValue } : {}),
      ...(resolved.policy ? { policyRevision: resolved.policy.policyRevision } : {}),
      // Correlation breadcrumbs (trace/step/tool-call) are NOT passed here: they
      // are copied from the authorizing staging row inside `reserveMcpInvocation`, so
      // they cannot drift from the row this reservation points at (#541).
    });

    if (!minted.ok) {
      return this.#resolveBlocked(input, argsHash, minted.reason);
    }

    const invocation = minted.invocation;

    // Cross the delivery boundary: persist `delivery_possible` BEFORE the network
    // hop so a crash mid-flight leaves durable evidence the write is ambiguous.
    //
    // NO-REPLAY INVARIANT (issue #540, VS Code findings): once an effectful call
    // is `delivery_possible`, NO layer may transparently re-send the same
    // `tools/call` — not the MCP SDK (progress-retry disabled via `maxTotalTimeout`
    // in protocol.ts), the raw client (`callTool` sends once; session-expiry
    // rethrows, never re-issues), the connection manager / session-refresh
    // (reconnect rebuilds a client for a LATER authorized attempt, never replays
    // this one), this broker (the catch below leaves the row unresolved), nor any
    // worker/model-loop retry (the durable barrier index refuses an identical
    // proposal). A second outbound attempt is legal only via an explicitly
    // reserved recovery successor. Before admitting any wrapper into this path,
    // confirm its retry is disabled or provably pre-delivery.
    requireRow(
      await markMcpInvocationDeliveryPossible({ id: invocation.id, userId: input.userId }),
      "markMcpInvocationDeliveryPossible",
    );

    try {
      const envelope = await resolved.prepared.call(ref, input.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
        trace: resolved.trace,
      });
      return this.#resolveResponse(invocation, envelope);
    } catch (err) {
      if (isProvenNotDelivered(err)) {
        // Deterministic failure that never reached the remote application: resolve
        // the reservation as not-delivered (retry-safe) and rethrow so the dispatch
        // seam records an ordinary `failed` staging row.
        requireRow(
          await settleMcpInvocationNotDelivered({
            id: invocation.id,
            userId: input.userId,
            lastError: boundedMcpErrorText(err),
          }),
          "settleMcpInvocationNotDelivered",
        );
        throw err;
      }
      // Possibly delivered (session_expired, invalid_output, transport/abort). The
      // write may have happened; leave the row UNRESOLVED so the barrier keeps
      // rejecting an identical repeat until a host-minted successor or a user check.
      //
      // If a response actually crossed the wire (today: invalid_output), the raw
      // client carries its census on the error — persist it and advance the
      // lifecycle to `response_received`, so the highest-value audit case (a
      // possibly-completed effect with a malformed response) stays reconstructable
      // from provenance, not just an error string (#541). The outcome stays
      // unknown/blocked: a malformed response can't prove the effect. When no
      // response arrived (transport/abort/session_expired), provenance is absent
      // and the lifecycle never advances past the delivery boundary.
      const provenance = err instanceof McpClientError ? err.provenance : undefined;
      requireRow(
        await blockMcpInvocationAsAmbiguous({
          id: invocation.id,
          userId: input.userId,
          lastError: boundedMcpErrorText(err),
          ...(provenance ? { resultProvenance: provenance } : {}),
        }),
        "blockMcpInvocationAsAmbiguous",
      );
      return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
    }
  }

  /** A clean response arrived. Only a confirmed success resolves an effectful call. */
  async #resolveResponse(
    invocation: McpInvocation,
    envelope: McpCallEnvelope,
  ): Promise<McpBrokerOutcome> {
    if (envelope.outcome === "tool_error") {
      // MCP `isError` says the tool reported a problem. It does not prove that
      // the tool applied no effect before it produced the response. Keep the
      // barrier unresolved unless a reviewed provider contract can prove the
      // call was rejected before application.
      requireRow(
        await blockMcpInvocationAsAmbiguous({
          id: invocation.id,
          userId: invocation.userId,
          lastError: MCP_TOOL_ERROR_MESSAGE,
          resultProvenance: envelope.provenance,
        }),
        "blockMcpInvocationAsAmbiguous tool_error",
      );
      return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
    }
    requireRow(
      await settleMcpInvocationSucceeded({
        id: invocation.id,
        userId: invocation.userId,
        resultProvenance: envelope.provenance,
      }),
      "settleMcpInvocationSucceeded",
    );
    return { status: "completed", invocationId: invocation.id, envelope };
  }

  /**
   * The reservation was refused. A `barrier` collision means a *different* staging
   * row already holds an unresolved match — read it so the block can be explained.
   * A `duplicate_staging` collision means THIS staging row was already recorded (a
   * crash between mint and the `executed` write); read that prior row rather than
   * re-delivering.
   */
  async #resolveBlocked(
    input: McpBrokerCallInput,
    argsHash: string,
    reason: "barrier" | "duplicate_staging",
  ): Promise<McpBrokerOutcome> {
    if (reason === "duplicate_staging") {
      const prior = await readInvocationByStagingId(input.stagingId);
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
