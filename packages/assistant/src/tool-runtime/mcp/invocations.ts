/**
 * MCP invocation ledger + per-tool policy persistence (PRD #540, #541) — durable
 * row access over the `mcp_invocation` and `mcp_tool_policy` tables, plus the ONE
 * identity derivation the approval gate and the execution broker share.
 *
 * This half of the MCP persistence layer lives in the tool runtime rather than in
 * `connections` because what it records is a tool call, not a connection: the
 * ambiguity barrier, the crash-recovery sweep, the reviewed risk downgrade, and
 * the `(current catalog revision, descriptor hash, reviewed policy)` resolution
 * that ADR-0088 makes fail-closed. It joins the `mcp_connections` and
 * `mcp_catalog_revisions` tables directly rather than through the connection
 * half's row readers, because the resolution is ONE query by design (it runs on
 * every `mcp.call` dispatch). Nothing in the connection half may import this
 * module: that edge would close a `connections` <-> `tool-runtime` cycle, which
 * the module-graph ratchet refuses by name.
 *
 * The genuinely-atomic operations here, each of which MUST be a transaction to be
 * crash-safe:
 *
 *  - `insertInvocation` — the barrier reservation. Inserting the ledger row IS
 *    the reservation; the partial unique index rejects a duplicate unresolved
 *    proposal, surfaced here as `{ ok: false, reason: "barrier" }`.
 *  - explicit successor reservation lives in `recovery.ts`, where the invocation
 *    and action-staging barriers can move in one transaction.
 *  - `reconcileInflightInvocations` — the crash-recovery barrier sweep run at
 *    boot (issue clarification #1).
 */

import { db } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import { isUniqueViolation, uniqueViolationConstraint } from "@alfred/db/pg-errors";
import {
  actionStagings,
  mcpCatalogRevisions,
  mcpConnections,
  mcpInvocation,
  mcpToolPolicy,
  type McpConnection,
  type McpInvocation,
  type McpToolPolicyRow,
  type NewMcpInvocation,
  type NewMcpToolPolicyRow,
} from "@alfred/db/schemas";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { McpResultProvenance } from "@alfred/contracts";

// ===========================================================================
// Per-tool policy (reviewed effect/retry/tier, bound to a descriptor hash)
// ===========================================================================

export async function readToolPolicy(
  connectionId: string,
  remoteName: string,
  descriptorHash: string,
  runner: DbRunner = db(),
): Promise<McpToolPolicyRow | undefined> {
  const [row] = await runner
    .select()
    .from(mcpToolPolicy)
    .where(
      and(
        eq(mcpToolPolicy.connectionId, connectionId),
        eq(mcpToolPolicy.remoteName, remoteName),
        eq(mcpToolPolicy.descriptorHash, descriptorHash),
      ),
    )
    .limit(1);
  return row;
}

export interface ResolveMcpToolIdentityInput {
  userId: string;
  connectionId: string;
  remoteName: string;
  /** The catalog revision under which the caller selected this tool. */
  catalogRevision: string;
}

export type OwnedMcpConnectionRef = Pick<McpConnection, "id" | "currentCatalogRevisionId">;

export type McpToolIdentityResolution =
  | {
      status: "resolved";
      connection: OwnedMcpConnectionRef;
      descriptorHash: string;
      policy: McpToolPolicyRow | undefined;
    }
  | {
      status: "unresolved";
      /**
       * Present when the connection exists and belongs to the caller. Consumers
       * may use its durable pointer, but no descriptor policy is authorized.
       */
      connection: OwnedMcpConnectionRef | undefined;
    };

/**
 * Resolve the durable identity of one selected MCP tool in ONE query.
 *
 * This is the owner of the `(current catalog revision, descriptor hash, reviewed
 * policy)` derivation used by both the approval gate and the execution broker.
 * A stale revision, absent descriptor, missing connection, or ownership miss
 * returns `unresolved`; callers must then use their conservative default.
 *
 * The policy join includes its denormalized `userId` as defense in depth. The
 * connection is the ownership authority, but a malformed cross-user policy row
 * must never authorize a downgrade merely because its descriptor key matches.
 */
export async function resolveMcpToolIdentity(
  input: ResolveMcpToolIdentityInput,
  runner: DbRunner = db(),
): Promise<McpToolIdentityResolution> {
  const descriptorHashExpr = sql<
    string | null
  >`${mcpCatalogRevisions.descriptorHashes} ->> ${input.remoteName}`;
  const [row] = await runner
    .select({
      connection: {
        id: mcpConnections.id,
        currentCatalogRevisionId: mcpConnections.currentCatalogRevisionId,
      },
      revisionHash: mcpCatalogRevisions.revisionHash,
      descriptorHash: descriptorHashExpr,
      policy: mcpToolPolicy,
    })
    .from(mcpConnections)
    .leftJoin(
      mcpCatalogRevisions,
      eq(mcpCatalogRevisions.id, mcpConnections.currentCatalogRevisionId),
    )
    .leftJoin(
      mcpToolPolicy,
      and(
        eq(mcpToolPolicy.userId, input.userId),
        eq(mcpToolPolicy.connectionId, mcpConnections.id),
        eq(mcpToolPolicy.remoteName, input.remoteName),
        eq(mcpToolPolicy.descriptorHash, descriptorHashExpr),
      ),
    )
    .where(and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)))
    .limit(1);

  if (!row || row.revisionHash !== input.catalogRevision || !row.descriptorHash) {
    return { status: "unresolved", connection: row?.connection };
  }

  return {
    status: "resolved",
    connection: row.connection,
    descriptorHash: row.descriptorHash,
    policy: row.policy ?? undefined,
  };
}

/**
 * Upsert the reviewed policy for a `(connection, remoteName, descriptorHash)`.
 * The descriptor hash is part of the key on purpose: a policy is bound to the
 * EXACT descriptor it was reviewed against, so descriptor drift produces a fresh
 * key (a miss) and the resolver falls back to the static `high` floor rather
 * than silently reusing a downgrade granted for a different descriptor.
 */
export async function upsertToolPolicy(
  values: NewMcpToolPolicyRow,
  runner: DbRunner = db(),
): Promise<McpToolPolicyRow> {
  const [row] = await runner
    .insert(mcpToolPolicy)
    .values(values)
    .onConflictDoUpdate({
      target: [mcpToolPolicy.connectionId, mcpToolPolicy.remoteName, mcpToolPolicy.descriptorHash],
      set: {
        policyRevision: values.policyRevision,
        riskTier: values.riskTier,
        effectClass: values.effectClass,
        retryContract: values.retryContract,
        reviewedAt: values.reviewedAt,
        reviewedNote: values.reviewedNote,
      },
    })
    .returning();
  return requireRow(row, "upsertToolPolicy");
}
// ===========================================================================
// Operation ledger
// ===========================================================================

/** Result of a barrier reservation attempt. */
export type InsertInvocationResult =
  | { ok: true; invocation: McpInvocation }
  | { ok: false; reason: "barrier" | "duplicate_staging" };

/**
 * The correlation breadcrumbs a ledger row carries so an ambiguous attempt is
 * reconstructable across Alfred's own traces (#541). They are a DENORMALIZED COPY
 * of the authorizing `action_stagings` row (`run_id` / `step_id` / `tool_call_id`),
 * which is the source of truth and already reachable via the 1:1 `staging_id` FK;
 * they live on the ledger only so an operator can pivot from a trace id to the row
 * without the join. Because nothing in the DB enforces the copy stays equal to its
 * staging twin, EVERY minter sources it HERE — from the staging row it is about to
 * point at — rather than from a separately-threaded dispatch ctx that could drift.
 * Sourcing it at the single insert choke point IS that enforcement.
 */
async function stagingCorrelation(
  stagingId: string,
  runner: DbRunner,
): Promise<{ traceId: string; stepId: string; toolCallId: string }> {
  const [staging] = await runner
    .select({
      traceId: actionStagings.runId,
      stepId: actionStagings.stepId,
      toolCallId: actionStagings.toolCallId,
    })
    .from(actionStagings)
    .where(eq(actionStagings.id, stagingId))
    .limit(1);
  return requireRow(staging, "stagingCorrelation");
}

/**
 * Reserve an operation by inserting its ledger row. The row is minted BEFORE
 * network dispatch, so a crash mid-flight still leaves durable evidence. The row
 * insert IS the ambiguity barrier: the partial unique index on
 * `(user, connection, remoteName, argsHash) WHERE resolvedAt IS NULL` rejects a
 * second unresolved proposal identical to an in-flight/blocked one (23505), and
 * the 1:1 `staging_id` index rejects a re-insert for the same staging row. Both
 * are reported as a typed non-throwing result so the broker decides the arm.
 */
export async function insertInvocation(
  values: NewMcpInvocation,
  runner: DbRunner = db(),
): Promise<InsertInvocationResult> {
  const correlation = await stagingCorrelation(values.stagingId, runner);
  try {
    const [invocation] = await runner
      .insert(mcpInvocation)
      .values({ ...values, ...correlation })
      .returning();
    return { ok: true, invocation: requireRow(invocation, "insertInvocation") };
  } catch (err) {
    // Two distinct outcomes ride on this narrowing, so both `@alfred/db/pg-errors`
    // helpers are needed: anything that is not a 23505 is a real failure and must
    // rethrow, while a 23505 whose constraint name the driver omitted defaults to
    // the barrier. Reading only the constraint name would collapse the first case
    // into the second.
    if (!isUniqueViolation(err)) throw err;
    if (uniqueViolationConstraint(err) === "mcp_invocation_staging_idx") {
      return { ok: false, reason: "duplicate_staging" };
    }
    // The barrier index (or an unnamed unique violation defaulting to barrier).
    return { ok: false, reason: "barrier" };
  }
}

/** Fields the broker patches onto a ledger row as an operation progresses. */
export type McpInvocationUpdate = Partial<
  Pick<
    NewMcpInvocation,
    | "attemptLifecycle"
    | "effectOutcome"
    | "retryDisposition"
    | "descriptorHash"
    | "policyRevision"
    | "catalogRevisionId"
    | "effectClass"
    | "resolvedAt"
    | "resolutionReason"
    | "lastError"
    | "resultProvenance"
    | "deliveryPossibleAt"
    | "responseReceivedAt"
  >
>;

export async function updateInvocation(
  id: string,
  patch: McpInvocationUpdate,
  runner: DbRunner = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .update(mcpInvocation)
    .set(patch)
    .where(eq(mcpInvocation.id, id))
    .returning();
  return row;
}

/**
 * The invocation minted for a staging row, if any. The `mcp_invocation_staging_idx`
 * enforces this is at most one. Used by the broker to recover the prior operation
 * when a re-dispatch of the SAME staging row collides with the 1:1 index (a crash
 * between minting the invocation and marking the staging row `executed`): the
 * broker reads the recorded state rather than re-delivering.
 */
export async function readInvocationByStagingId(
  stagingId: string,
  runner: DbRunner = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .select()
    .from(mcpInvocation)
    .where(eq(mcpInvocation.stagingId, stagingId))
    .limit(1);
  return row;
}

/**
 * The single unresolved operation matching a proposal, if one exists — the same
 * shape the partial barrier index enforces. Lets the broker read WHY a repeat is
 * blocked (to explain it) instead of only learning it collided.
 */
export async function findUnresolvedBarrier(
  key: { userId: string; connectionId: string; remoteName: string; argsHash: string },
  runner: DbRunner = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .select()
    .from(mcpInvocation)
    .where(
      and(
        eq(mcpInvocation.userId, key.userId),
        eq(mcpInvocation.connectionId, key.connectionId),
        eq(mcpInvocation.remoteName, key.remoteName),
        eq(mcpInvocation.argsHash, key.argsHash),
        isNull(mcpInvocation.resolvedAt),
      ),
    )
    .limit(1);
  return row;
}

export async function readReservedMcpSuccessor(
  input: { userId: string; invocationId: string },
  runner: DbRunner = db(),
): Promise<{ invocation: McpInvocation; effectiveInput: unknown } | undefined> {
  const [row] = await runner
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

/** Claim a pre-reserved successor exactly once before its network hop. */
export async function claimReservedMcpSuccessorDelivery(
  input: { userId: string; invocationId: string },
  runner: DbRunner = db(),
): Promise<McpInvocation | undefined> {
  const [claimed] = await runner
    .update(mcpInvocation)
    .set({ attemptLifecycle: "delivery_possible", deliveryPossibleAt: new Date() })
    .where(
      and(
        eq(mcpInvocation.id, input.invocationId),
        eq(mcpInvocation.userId, input.userId),
        eq(mcpInvocation.attemptLifecycle, "prepared"),
        isNull(mcpInvocation.resolvedAt),
        isNotNull(mcpInvocation.successorOf),
      ),
    )
    .returning();
  return claimed;
}

export type ReservedMcpSuccessorSettlement =
  | { kind: "succeeded"; resultProvenance: McpResultProvenance }
  | { kind: "rejected"; resultProvenance: McpResultProvenance }
  | { kind: "not_delivered"; lastError: string }
  | {
      kind: "ambiguous";
      lastError: string;
      resultProvenance?: McpResultProvenance;
    };

/** Settle the successor invocation and its action-staging barrier together. */
export async function settleReservedMcpSuccessor(
  input: { userId: string; invocationId: string; settlement: ReservedMcpSuccessorSettlement },
  runner: DbRunner = db(),
): Promise<void> {
  await runAtomic(runner, async (tx) => {
    const now = new Date();
    const ambiguous = input.settlement.kind === "ambiguous";
    const succeeded = input.settlement.kind === "succeeded";
    const rejected = input.settlement.kind === "rejected";
    const provenance =
      input.settlement.kind === "succeeded" || input.settlement.kind === "rejected"
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
          : succeeded || rejected
            ? {
                attemptLifecycle: "response_received" as const,
                responseReceivedAt: now,
                resultProvenance: provenance,
              }
            : {}),
        effectOutcome: succeeded
          ? "succeeded"
          : rejected
            ? "rejected"
            : ambiguous
              ? "unknown"
              : "failed",
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
          isNotNull(mcpInvocation.successorOf),
        ),
      )
      .returning({ stagingId: mcpInvocation.stagingId });
    const row = requireRow(updated, "settleReservedMcpSuccessor");
    await tx
      .update(actionStagings)
      .set({
        status: input.settlement.kind === "not_delivered" ? "failed" : "executed",
        outcome: succeeded ? "succeeded" : ambiguous ? "unknown" : "failed",
        executedAt: now,
        rowVersion: sql`${actionStagings.rowVersion} + 1`,
      })
      .where(and(eq(actionStagings.id, row.stagingId), eq(actionStagings.userId, input.userId)));
  });
}

export interface ReconcileSummary {
  /** `prepared` rows that never reached delivery — safe, resolved. */
  abandoned: number;
  /** `delivery_possible` reads that are idempotent — safe, resolved. */
  resolvedReads: number;
  /** `delivery_possible` effectful rows — outcome unknown, left BLOCKED. */
  markedUnknown: number;
}

/**
 * Crash-recovery sweep, run at boot before any new dispatch (clarification #1).
 * Three transitions over rows left unresolved by a previous process:
 *
 *  - `prepared`: the row was reserved but the raw-client call was never made
 *    (no delivery possible). Resolve it — the barrier should not block a fresh
 *    attempt of an operation that provably never left the host.
 *  - `delivery_possible` + `read`: a read is idempotent, so an ambiguous read is
 *    safe to resolve and re-run; it never needed the block.
 *  - `delivery_possible` + `write`/`unknown` + no outcome: the effect is
 *    genuinely ambiguous. Mark the outcome `unknown` / disposition `blocked` but
 *    leave `resolvedAt` NULL so the barrier keeps rejecting an identical repeat
 *    until a host-minted successor (or explicit user resolution) clears it.
 */
export async function reconcileInflightInvocations(
  userId?: string,
  runner: DbRunner = db(),
): Promise<ReconcileSummary> {
  const run = async (tx: DbRunner): Promise<ReconcileSummary> => {
    const scope = userId ? [eq(mcpInvocation.userId, userId)] : [];

    const abandoned = await tx
      .update(mcpInvocation)
      .set({
        resolvedAt: sql`now()`,
        resolutionReason: "reconciled_abandoned",
        retryDisposition: "safe",
      })
      .where(
        and(
          ...scope,
          eq(mcpInvocation.attemptLifecycle, "prepared"),
          isNull(mcpInvocation.successorOf),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id });

    const resolvedReads = await tx
      .update(mcpInvocation)
      .set({
        resolvedAt: sql`now()`,
        resolutionReason: "reconciled_read_safe",
        retryDisposition: "safe",
      })
      .where(
        and(
          ...scope,
          eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
          eq(mcpInvocation.effectClass, "read"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id });

    const markedUnknown = await tx
      .update(mcpInvocation)
      .set({
        effectOutcome: "unknown",
        retryDisposition: "blocked",
        resolutionReason: "reconciled_ambiguous",
      })
      .where(
        and(
          ...scope,
          eq(mcpInvocation.attemptLifecycle, "delivery_possible"),
          isNull(mcpInvocation.effectOutcome),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .returning({ id: mcpInvocation.id, stagingId: mcpInvocation.stagingId });

    if (markedUnknown.length > 0) {
      await tx
        .update(actionStagings)
        .set({
          status: "executed",
          outcome: "unknown",
          executedAt: sql`coalesce(${actionStagings.executedAt}, now())`,
          rowVersion: sql`${actionStagings.rowVersion} + 1`,
        })
        .where(
          inArray(
            actionStagings.id,
            markedUnknown.map((row) => row.stagingId),
          ),
        );
    }

    return {
      abandoned: abandoned.length,
      resolvedReads: resolvedReads.length,
      markedUnknown: markedUnknown.length,
    };
  };
  return runAtomic(runner, run);
}
