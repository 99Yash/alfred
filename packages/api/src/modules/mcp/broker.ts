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

import type { McpEffectClass } from "@alfred/contracts";
import type { McpInvocation, McpToolPolicyRow } from "@alfred/db/schemas";
import type { ExternalToolRef, McpCallEnvelope, McpPreparedToolCall } from "./client";
import { McpClientError, boundedMcpErrorText, isPreDeliveryErrorCode } from "./errors";
import { canonicalArgsHash, descriptorHash } from "./hash";
import type { McpConnectionManager } from "./manager";
import {
  findUnresolvedBarrier,
  insertInvocation,
  readInvocationByStagingId,
  resolveMcpToolIdentity,
  type OwnedMcpConnectionRef,
  updateInvocation,
} from "./persistence";
import { startMcpTraceSpan, type McpTraceContext } from "./trace";

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
  /** Run trace id. Observability only; ledger correlation still copies the staging row. */
  traceId?: string;
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
    const prepared = await this.#manager.prepareToolCall(ref.connectionId, input.signal);
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
    const minted = await insertInvocation({
      stagingId: input.stagingId,
      userId: input.userId,
      connectionId: ref.connectionId,
      remoteName: ref.remoteName,
      argsHash,
      effectClass: resolved.effectClass,
      attemptLifecycle: "prepared",
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
      // are copied from the authorizing staging row inside `insertInvocation`, so
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
    // proposal). A second outbound attempt is legal only via a host-minted
    // successor (`createSuccessorInvocation`). Before admitting any wrapper into
    // this path, confirm its retry is disabled or provably pre-delivery.
    await updateInvocation(invocation.id, {
      attemptLifecycle: "delivery_possible",
      deliveryPossibleAt: new Date(),
    });

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
        await updateInvocation(invocation.id, {
          effectOutcome: "failed",
          retryDisposition: "safe",
          resolvedAt: new Date(),
          resolutionReason: "not_delivered",
          lastError: boundedMcpErrorText(err),
        });
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
      await updateInvocation(invocation.id, {
        ...(provenance
          ? {
              attemptLifecycle: "response_received",
              responseReceivedAt: new Date(),
              resultProvenance: provenance,
            }
          : {}),
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        resolutionReason: "ambiguous_delivery",
        lastError: boundedMcpErrorText(err),
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
        responseReceivedAt: new Date(),
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
      responseReceivedAt: new Date(),
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
