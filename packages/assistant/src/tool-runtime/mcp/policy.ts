/**
 * Per-descriptor policy reviews for `mcp.call` (ADR-0088, ADR-0096).
 * A review binds to the descriptor hash of the revision the owner inspected.
 * If that revision is no longer current, the answer is `catalog_stale`.
 * Mutations lock the connection row first; catalog publication updates that row, so it waits.
 */

import type {
  ExternalToolRef,
  McpEffectClass,
  McpRetryContract,
  ToolRiskTier,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { runAtomic, type DbRunner } from "@alfred/db/helpers";
import { mcpConnections, mcpToolPolicy, type McpToolPolicyRow } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import {
  resolveMcpToolIdentity,
  upsertToolPolicy,
  type McpToolIdentityResolution,
  type ResolveMcpToolIdentityInput,
} from "./invocations";

/** Review state of one `(connection, remoteName)` at a caller-named revision. */
export type McpToolPolicyState =
  | { status: "reviewed"; policy: McpToolPolicyRow }
  | { status: "unreviewed" }
  | { status: "drifted"; previous: McpToolPolicyRow }
  | { status: "catalog_stale" }
  | { status: "not_found" }
  | { status: "connection_missing" };

/** Narrowed to what a write can return, so the route handles exactly these. */
export type McpToolPolicyReviewState = Extract<
  McpToolPolicyState,
  { status: "reviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

export type McpToolPolicyClearState = Extract<
  McpToolPolicyState,
  { status: "unreviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

type UnresolvedIdentity = Extract<McpToolIdentityResolution, { status: "unresolved" }>;

/** A subtype of both write results, so a mutation can return it directly. */
type McpToolPolicyUnresolvedState = Extract<
  McpToolPolicyState,
  { status: "catalog_stale" | "not_found" | "connection_missing" }
>;

function identityInput(input: {
  userId: string;
  ref: ExternalToolRef;
}): ResolveMcpToolIdentityInput {
  return {
    userId: input.userId,
    connectionId: input.ref.connectionId,
    remoteName: input.ref.remoteName,
    catalogRevision: input.ref.catalogRevision,
  };
}

function policyStateFromUnresolved(unresolved: UnresolvedIdentity): McpToolPolicyUnresolvedState {
  switch (unresolved.reason) {
    case "connection_missing":
      return { status: "connection_missing" };
    case "revision_stale":
      return { status: "catalog_stale" };
    case "descriptor_missing":
      return { status: "not_found" };
  }
}

/** Lock the owned connection row so the revision cannot move before the write. False if not owned. */
async function lockOwnedConnection(
  tx: DbTransaction,
  userId: string,
  connectionId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.userId, userId)))
    .for("update");

  return row !== undefined;
}

/** The latest review for the pair under any descriptor hash. Fills `drifted.previous`. */
async function readLatestPairPolicy(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner,
): Promise<McpToolPolicyRow | undefined> {
  const [row] = await runner
    .select()
    .from(mcpToolPolicy)
    .where(
      and(
        eq(mcpToolPolicy.userId, input.userId),
        eq(mcpToolPolicy.connectionId, input.ref.connectionId),
        eq(mcpToolPolicy.remoteName, input.ref.remoteName),
      ),
    )
    .orderBy(desc(mcpToolPolicy.updatedAt), desc(mcpToolPolicy.id))
    .limit(1);

  return row;
}

/** Read the review state of one tool. A review under another descriptor is `drifted`; the gate keeps the floor. */
export async function readMcpToolPolicyState(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpToolPolicyState> {
  const identity = await resolveMcpToolIdentity(identityInput(input), runner);

  if (identity.status === "unresolved") return policyStateFromUnresolved(identity);

  if (identity.policy !== undefined) return { status: "reviewed", policy: identity.policy };

  if (!identity.reviewed) return { status: "unreviewed" };

  const previous = await readLatestPairPolicy(input, runner);

  // A concurrent clear landed between the two reads.
  if (previous === undefined) return { status: "unreviewed" };

  return { status: "drifted", previous };
}

/** Write the owner's review for the descriptor they inspected. `policyRevision` counts up from 1. */
export async function reviewMcpToolPolicy(
  input: {
    userId: string;
    ref: ExternalToolRef;
    riskTier: ToolRiskTier;
    effectClass: McpEffectClass;
    retryContract: McpRetryContract;
    note: string | null;
  },
  runner: DbRunner = db(),
): Promise<McpToolPolicyReviewState> {
  return runAtomic(runner, async (tx) => {
    if (!(await lockOwnedConnection(tx, input.userId, input.ref.connectionId))) {
      return { status: "connection_missing" };
    }

    const identity = await resolveMcpToolIdentity(identityInput(input), tx);

    if (identity.status === "unresolved") {
      return policyStateFromUnresolved(identity);
    }

    const policy = await upsertToolPolicy(
      {
        userId: input.userId,
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        // The server's hash, never the caller's.
        descriptorHash: identity.descriptorHash,
        policyRevision: (identity.policy?.policyRevision ?? 0) + 1,
        riskTier: input.riskTier,
        effectClass: input.effectClass,
        retryContract: input.retryContract,
        reviewedAt: new Date(),
        reviewedNote: input.note,
      },
      tx,
    );

    return { status: "reviewed", policy };
  });
}

/**
 * Clear every review for the pair, under all descriptor hashes.
 * `reviewed` ignores the hash, so one leftover row would block the structural downgrade forever.
 */
export async function clearMcpToolPolicy(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpToolPolicyClearState> {
  return runAtomic(runner, async (tx) => {
    if (!(await lockOwnedConnection(tx, input.userId, input.ref.connectionId))) {
      return { status: "connection_missing" };
    }

    const identity = await resolveMcpToolIdentity(identityInput(input), tx);

    if (identity.status === "unresolved") {
      return policyStateFromUnresolved(identity);
    }

    await tx
      .delete(mcpToolPolicy)
      .where(
        and(
          eq(mcpToolPolicy.userId, input.userId),
          eq(mcpToolPolicy.connectionId, input.ref.connectionId),
          eq(mcpToolPolicy.remoteName, input.ref.remoteName),
        ),
      );

    return { status: "unreviewed" };
  });
}
