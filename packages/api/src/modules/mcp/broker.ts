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
 * connect → refresh → call runs with no socket. Successor minting stays
 * host-owned in `persistence.createSuccessorInvocation`; the broker never mints a
 * successor from a model proposal (clarification #4).
 */

import { sanitizeErrorMessage, summarizeBody, toMessage } from "@alfred/contracts";
import type { McpEffectClass } from "@alfred/contracts";
import type { McpConnection, McpInvocation } from "@alfred/db/schemas";
import type { ExternalToolRef, McpCallEnvelope } from "./client";
import { McpClientError, isPreDeliveryErrorCode } from "./errors";
import { canonicalArgsHash, descriptorHash } from "./hash";
import type { McpConnectionManager } from "./manager";
import {
  findUnresolvedBarrier,
  insertInvocation,
  readConnection,
  readInvocationByStagingId,
  readToolPolicy,
  updateInvocation,
} from "./persistence";

/** Cap on the error text persisted to a ledger row / surfaced to the model. */
const MAX_LEDGER_ERROR_CHARS = 500;

const BLOCKED_BARRIER_MESSAGE =
  "A matching write to this MCP tool is already unresolved (it may have been delivered). " +
  "It will not be repeated until its outcome is confirmed or explicitly superseded.";

const BLOCKED_RECORDED_MESSAGE =
  "This exact call was already recorded and may have been delivered. " +
  "Its outcome must be checked before it can be attempted again.";

const AMBIGUOUS_MESSAGE =
  "The remote MCP write may have completed, but Alfred did not receive a confirmation. " +
  "It will not be repeated automatically until its state is checked.";

export interface McpBrokerCallInput {
  userId: string;
  /** The `action_stagings` row that authorized this call (1:1 with the ledger row). */
  stagingId: string;
  ref: ExternalToolRef;
  /** Opaque MCP arguments — validated against the exact tool schema by the raw client. */
  arguments: unknown;
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
 *  - `completed` / `tool_error`: a clean response was received.
 *  - `blocked`: the barrier refused the reservation; NOTHING was dispatched.
 *  - `ambiguous`: a possibly-delivered failure; the write may have happened and
 *    the ledger row stays unresolved so an identical repeat keeps being blocked.
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

function boundedError(err: unknown): string {
  return summarizeBody(sanitizeErrorMessage(toMessage(err)), MAX_LEDGER_ERROR_CHARS);
}

/** True only for a deterministic pre-delivery `McpClientError` (provably not delivered). */
function isProvenNotDelivered(err: unknown): boolean {
  return err instanceof McpClientError && isPreDeliveryErrorCode(err.code);
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
    const { ref } = input;

    // Ownership is Alfred's trust boundary: an outbound effect must land only on a
    // connection the CALLING user owns. A model-proposed `connectionId` that is
    // absent — or owned by another user — is indistinguishable from "not
    // connected", the same scope `listMcpToolsLocal` enforces on the read half.
    // This runs BEFORE any client connect or ledger row: an ownership miss provably
    // predates any `tools/call`, so it throws a deterministic pre-delivery error
    // (no barrier minted) and the dispatch seam records an ordinary failure. It is
    // enforced here, at the read, rather than left as a convention for multi-user.
    const connection = await readConnection(ref.connectionId);
    if (!connection || connection.userId !== input.userId) {
      throw new McpClientError(
        "not_connected",
        `No connected MCP server '${ref.connectionId}'.`,
      );
    }

    // Connecting/refreshing the catalog is a prerequisite, not the tool-call
    // delivery boundary: a failure here provably predates any `tools/call`, so it
    // throws (deterministic failure) with no ledger row minted.
    const client = await this.#manager.getReadyClient(ref.connectionId);

    // Resolve reviewed effect/retry policy, bound to the EXACT descriptor. A
    // descriptor miss (drift, or a tool not in the live catalog) yields no policy,
    // so the effect class defaults to `unknown` — handled conservatively as an
    // effectful, ambiguity-protected call.
    const liveTool = client.catalog?.tools.find((tool) => tool.name === ref.remoteName);
    const hash = liveTool ? descriptorHash(liveTool) : undefined;
    const policy = hash
      ? await readToolPolicy(ref.connectionId, ref.remoteName, hash)
      : undefined;
    const effectClass: McpEffectClass = policy?.effectClass ?? "unknown";

    if (effectClass === "read") {
      // Reads are idempotent: no barrier, no ledger row. Any failure (including a
      // possibly-delivered one) is safe to surface and re-run, so it just throws.
      const envelope = await this.#manager.callTool(ref, input.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
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
    });
  }

  async #callEffectful(
    input: McpBrokerCallInput,
    resolved: {
      effectClass: McpEffectClass;
      descriptorHashValue: string | undefined;
      policy: Awaited<ReturnType<typeof readToolPolicy>>;
      /** The owner-verified connection already read in `callTool`. */
      connection: McpConnection;
    },
  ): Promise<McpBrokerOutcome> {
    const { ref } = input;
    const argsHash = canonicalArgsHash(input.arguments);
    // Only the current-revision POINTER is needed for the ledger row, and the
    // owner-verified connection was already read in `callTool`, so reuse it rather
    // than re-fetching (its full revision's descriptors/hashes jsonb runs to the
    // catalog ceiling — the row itself carries only the id we need).
    const connection = resolved.connection;

    // The reservation. Minting the row IS the barrier: the partial unique index
    // rejects a second unresolved proposal identical to an in-flight/blocked one.
    const minted = await insertInvocation({
      stagingId: input.stagingId,
      userId: input.userId,
      connectionId: ref.connectionId,
      remoteName: ref.remoteName,
      argsHash,
      effectClass: resolved.effectClass,
      attemptLifecycle: "prepared",
      ...(connection?.currentCatalogRevisionId
        ? { catalogRevisionId: connection.currentCatalogRevisionId }
        : {}),
      ...(resolved.descriptorHashValue ? { descriptorHash: resolved.descriptorHashValue } : {}),
      ...(resolved.policy ? { policyRevision: resolved.policy.policyRevision } : {}),
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
    // proposal). A second outbound attempt is legal only via a host-minted
    // successor (`createSuccessorInvocation`). Before admitting any wrapper into
    // this path, confirm its retry is disabled or provably pre-delivery.
    await updateInvocation(invocation.id, { attemptLifecycle: "delivery_possible" });

    try {
      const envelope = await this.#manager.callTool(ref, input.arguments, {
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return this.#resolveResponse(invocation, envelope);
    } catch (err) {
      if (isProvenNotDelivered(err)) {
        // Deterministic failure that never reached the remote application: resolve
        // the reservation as not-delivered (retry-safe) and rethrow so the dispatch
        // seam records an ordinary `failed` staging row.
        await updateInvocation(invocation.id, {
          effectOutcome: "failed",
          retryDisposition: "safe",
          resolvedAt: new Date(),
          resolutionReason: "not_delivered",
          lastError: boundedError(err),
        });
        throw err;
      }
      // Possibly delivered (session_expired, invalid_output, transport/abort). The
      // write may have happened; leave the row UNRESOLVED so the barrier keeps
      // rejecting an identical repeat until a host-minted successor or a user check.
      await updateInvocation(invocation.id, {
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        resolutionReason: "ambiguous_delivery",
        lastError: boundedError(err),
      });
      return { status: "ambiguous", invocationId: invocation.id, message: AMBIGUOUS_MESSAGE };
    }
  }

  /** A clean response arrived: the outcome is definitive, so the row resolves. */
  async #resolveResponse(
    invocation: McpInvocation,
    envelope: McpCallEnvelope,
  ): Promise<McpBrokerOutcome> {
    if (envelope.outcome === "tool_error") {
      // The server received and definitively REJECTED the call — no effect, safe
      // to attempt again as a fresh intent. The provenance envelope is persisted
      // even for a rejection: a tool-level error still carries content the audit
      // view reconstructs from (#541).
      await updateInvocation(invocation.id, {
        attemptLifecycle: "response_received",
        effectOutcome: "rejected",
        retryDisposition: "safe",
        resolvedAt: new Date(),
        resolutionReason: "rejected",
        resultProvenance: envelope.provenance,
      });
      return { status: "tool_error", invocationId: invocation.id, envelope };
    }
    await updateInvocation(invocation.id, {
      attemptLifecycle: "response_received",
      effectOutcome: "succeeded",
      resolvedAt: new Date(),
      resolutionReason: "succeeded",
      resultProvenance: envelope.provenance,
    });
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
