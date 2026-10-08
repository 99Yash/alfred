/**
 * Persistence for `mcp_invocation` and `mcp_tool_policy`, plus the one tool-identity
 * resolution the approval gate and the broker share (ADR-0088).
 * The connection half must not import this module: that makes a cycle.
 * Normal-call transitions live in `broker.ts`; successor reservation in `recovery.ts`.
 */

import { db } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import {
  actionStagings,
  mcpCatalogRevisions,
  mcpConnections,
  mcpInvocation,
  mcpServers,
  mcpToolPolicy,
  type McpConnection,
  type McpInvocation,
  type McpToolPolicyRow,
  type NewMcpToolPolicyRow,
} from "@alfred/db/schemas";
import {
  builtInReadOnlyResource,
  type McpConnectionRemovalGate,
} from "@alfred/assistant/connections/mcp";
import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

// --- Per-tool policy ---

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
      /** The review for this exact descriptor. */
      policy: McpToolPolicyRow | undefined;
      /** A review exists under any descriptor hash. Drift must re-gate, not fall to the structural downgrade (ADR-0096). */
      reviewed: boolean;
      /** The endpoint is a built-in read-only resource, and this descriptor set `readOnlyHint` (ADR-0096). */
      readOnlyResource: boolean;
      readOnly: boolean;
    }
  | {
      status: "unresolved";
      /** Why. The floor is the same; the UI shows the reason. `revision_stale` also covers no published revision. */
      reason: McpToolIdentityUnresolvedReason;
      /** Set when the caller owns the connection. */
      connection: OwnedMcpConnectionRef | undefined;
    };

export type McpToolIdentityUnresolvedReason =
  | "connection_missing"
  | "revision_stale"
  | "descriptor_missing";

type ResolvedMcpToolIdentity = Extract<McpToolIdentityResolution, { status: "resolved" }>;

/** The exact descriptor/policy pair that may authorize a fixed read. */
export function isReadOnlyMcpToolIdentity(identity: ResolvedMcpToolIdentity): boolean {
  return (
    identity.readOnly === true &&
    (identity.policy === undefined || identity.policy.effectClass === "read")
  );
}

/**
 * Resolve one selected MCP tool's identity in one query (runs on every `mcp.call`).
 * Stale revision, missing descriptor, or foreign connection gives `unresolved`.
 * The policy join also checks `userId`, so a cross-user row never downgrades.
 */
export async function resolveMcpToolIdentity(
  input: ResolveMcpToolIdentityInput,
  runner: DbRunner = db(),
): Promise<McpToolIdentityResolution> {
  const descriptorHashExpr = sql<
    string | null
  >`${mcpCatalogRevisions.descriptorHashes} ->> ${input.remoteName}`;

  // Alias of the same table that ignores the descriptor hash.
  const anyReviewedPolicy = alias(mcpToolPolicy, "any_reviewed_policy");

  const [row] = await runner
    .select({
      connection: {
        id: mcpConnections.id,
        currentCatalogRevisionId: mcpConnections.currentCatalogRevisionId,
      },
      revisionHash: mcpCatalogRevisions.revisionHash,
      descriptorHash: descriptorHashExpr,
      // Only a literal `true` counts as a read-only claim.
      readOnly: sql<boolean>`coalesce(
        ${mcpCatalogRevisions.readOnlyHints} -> ${input.remoteName} = 'true'::jsonb, false
      )`,
      // `exists`, not a join: one row per historic review would multiply the result.
      reviewed: exists(
        runner
          .select({ reviewed: sql`1` })
          .from(anyReviewedPolicy)
          .where(
            and(
              eq(anyReviewedPolicy.userId, input.userId),
              eq(anyReviewedPolicy.connectionId, mcpConnections.id),
              eq(anyReviewedPolicy.remoteName, input.remoteName),
            ),
          ),
      ),
      endpointUrl: mcpServers.endpointUrl,
      policy: mcpToolPolicy,
    })
    .from(mcpConnections)
    // Inner join: no server row, no endpoint, no identity.
    .innerJoin(
      mcpServers,
      and(eq(mcpServers.id, mcpConnections.serverId), eq(mcpServers.userId, input.userId)),
    )
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

  if (!row) {
    return { status: "unresolved", reason: "connection_missing", connection: undefined };
  }

  if (row.revisionHash !== input.catalogRevision) {
    return { status: "unresolved", reason: "revision_stale", connection: row.connection };
  }

  if (!row.descriptorHash) {
    return { status: "unresolved", reason: "descriptor_missing", connection: row.connection };
  }

  return {
    status: "resolved",
    connection: row.connection,
    descriptorHash: row.descriptorHash,
    policy: row.policy ?? undefined,
    reviewed: row.reviewed === true,
    // Key on the endpoint, not `canonical_resource`: a moved endpoint loses the downgrade (ADR-0094).
    readOnlyResource: builtInReadOnlyResource(row.endpointUrl),
    readOnly: row.readOnly === true,
  };
}

/** Upsert a review. The descriptor hash is in the key, so drift misses and falls back to `high`. */
export async function upsertToolPolicy(
  values: NewMcpToolPolicyRow,
  runner: DbRunner = db(),
): Promise<McpToolPolicyRow> {
  return runAtomic(runner, async (tx) => {
    // Lock the connection row so a first review cannot appear mid successor reservation.
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
// --- Operation ledger ---

/** The one invocation for a staging row. A re-dispatch after a crash reads it instead of sending again. */
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

/** The unresolved operation that blocks a repeat, so the broker can explain the block. */
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

/**
 * Block connection removal while an invocation is unresolved, so ambiguous-write evidence survives.
 * Injected into the connection half, which must not import the ledger.
 */
export const mcpUnresolvedInvocationGate: McpConnectionRemovalGate = {
  async blocks(tx, { connectionId, userId }) {
    const [row] = await tx
      .select({ id: mcpInvocation.id })
      .from(mcpInvocation)
      .where(
        and(
          eq(mcpInvocation.userId, userId),
          eq(mcpInvocation.connectionId, connectionId),
          isNull(mcpInvocation.resolvedAt),
        ),
      )
      .limit(1);

    return row !== undefined;
  },
};

export interface ReconcileSummary {
  /** `prepared` rows that never sent. Resolved. */
  abandoned: number;
  /** `delivery_possible` reads. Resolved. */
  resolvedReads: number;
  /** `delivery_possible` writes. Outcome unknown, left blocked. */
  markedUnknown: number;
  /** Split invocation/staging barriers repaired without sending. */
  alignedStagingBarriers: number;
}

/**
 * Boot sweep over rows a dead process left unresolved, before any dispatch.
 * Resolve `prepared` rows and ambiguous reads. Mark ambiguous writes `unknown`
 * and `blocked`, but keep `resolvedAt` null so an identical repeat still fails.
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

    // A crash between the invocation's `unknown` write and the staging write splits them.
    // Align the staging half. No network call.
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
            inArray(actionStagings.outcome, ["planned", "dispatching", "failed", "succeeded"]),
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
