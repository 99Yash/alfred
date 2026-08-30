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
 *  - normal-call reservation and lifecycle transitions live module-private in
 *    `broker.ts`, where they own the invocation and staging rows together.
 *  - explicit successor reservation lives in `recovery.ts`, where the invocation
 *    and action-staging barriers can move in one transaction.
 *  - `reconcileInflightInvocations` — the crash-recovery barrier sweep run at
 *    boot (issue clarification #1).
 */

import { db } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import {
  actionStagings,
  mcpCatalogRevisions,
  mcpConnections,
  mcpInvocation,
  mcpToolPolicy,
  type McpConnection,
  type McpInvocation,
  type McpToolPolicyRow,
  type NewMcpToolPolicyRow,
} from "@alfred/db/schemas";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

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
  return runAtomic(runner, async (tx) => {
    // Policy publication and explicit successor reservation serialize on the
    // connection row. This makes an absent policy as stable as a present one:
    // a concurrent first review cannot appear between recovery validation and
    // the barrier transition, while catalog and ownership writers already take
    // this same PostgreSQL row lock through their connection update.
    const [ownedConnection] = await tx
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(
        and(eq(mcpConnections.id, values.connectionId), eq(mcpConnections.userId, values.userId)),
      )
      .for("update");
    requireRow(ownedConnection, "upsertToolPolicy owned connection");

    const [row] = await tx
      .insert(mcpToolPolicy)
      .values(values)
      .onConflictDoUpdate({
        target: [
          mcpToolPolicy.connectionId,
          mcpToolPolicy.remoteName,
          mcpToolPolicy.descriptorHash,
        ],
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
  });
}
// ===========================================================================
// Operation ledger
// ===========================================================================

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

export interface ReconcileSummary {
  /** `prepared` rows that never reached delivery — safe, resolved. */
  abandoned: number;
  /** `delivery_possible` reads that are idempotent — safe, resolved. */
  resolvedReads: number;
  /** `delivery_possible` effectful rows — outcome unknown, left BLOCKED. */
  markedUnknown: number;
  /** Split invocation/staging barriers repaired without sending. */
  alignedStagingBarriers: number;
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

    // The broker can persist its unknown outcome before the dispatch owner
    // persists the matching action-staging outcome. A process crash in that
    // narrow gap leaves `mcp_invocation.effect_outcome = unknown` with staging
    // still `dispatching` (or null on older rows). The old sweep only selected a
    // null invocation outcome, so that split state survived every restart and
    // both explicit recovery choices rejected it. Find the split AFTER the
    // normalization above and align only the staging half. This is a database
    // repair; it never calls the broker or a remote MCP server.
    const splitStagingBarriers = await tx
      .select({ stagingId: actionStagings.id })
      .from(mcpInvocation)
      .innerJoin(actionStagings, eq(actionStagings.id, mcpInvocation.stagingId))
      .where(
        and(
          ...scope,
          inArray(mcpInvocation.attemptLifecycle, ["delivery_possible", "response_received"]),
          eq(mcpInvocation.effectOutcome, "unknown"),
          eq(mcpInvocation.retryDisposition, "blocked"),
          isNull(mcpInvocation.resolvedAt),
          or(
            inArray(actionStagings.outcome, ["planned", "dispatching", "failed"]),
            isNull(actionStagings.outcome),
          ),
        ),
      );

    if (splitStagingBarriers.length > 0) {
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
            splitStagingBarriers.map((row) => row.stagingId),
          ),
        );
    }

    return {
      abandoned: abandoned.length,
      resolvedReads: resolvedReads.length,
      markedUnknown: markedUnknown.length,
      alignedStagingBarriers: splitStagingBarriers.length,
    };
  };
  return runAtomic(runner, run);
}
