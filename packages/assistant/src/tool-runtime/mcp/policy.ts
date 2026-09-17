/**
 * Exact-descriptor policy review (ADR-0088 / ADR-0096).
 *
 * `mcp.call` carries a static `high` floor; `mcp_tool_policy` is the only other
 * input that can lower it, and it binds to the EXACT descriptor the owner
 * reviewed. This module is the product half ADR-0096 called residual: a
 * per-descriptor review surface for user-added servers, where the structural
 * read-only downgrade does not apply. It owns three operations over the SAME
 * identity derivation the dispatch gate uses — {@link resolveMcpToolIdentity} —
 * so a review can never be bound to a descriptor the gate would resolve
 * differently.
 *
 * The binding rule is one sentence: a review is written under the descriptor
 * hash `resolveMcpToolIdentity` derives from `ref.catalogRevision`, and only
 * when that revision is the connection's CURRENT one. The owner's `ref` is the
 * revision they inspected, never `connection.currentCatalogRevisionId`; a
 * catalog publication between inspect and save therefore answers `catalog_stale`
 * instead of transplanting the review onto a descriptor the owner never saw.
 *
 * Concurrency: every mutation takes the owned connection row `FOR UPDATE`
 * BEFORE resolving, because catalog publication holds that same lock. Without
 * the lock, a publication could move `currentCatalogRevisionId` between the
 * resolver read and the policy write.
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

/**
 * The state of one `(connection, remoteName)` against a caller-named revision.
 *
 * `connection_missing` is the only arm with no durable answer to give: the
 * route turns it into a 404, because a caller that cannot name an owned
 * connection has nothing to read.
 */
export type McpToolPolicyState =
  | { status: "reviewed"; policy: McpToolPolicyRow }
  | { status: "unreviewed" }
  | { status: "drifted"; previous: McpToolPolicyRow }
  | { status: "catalog_stale" }
  | { status: "not_found" }
  | { status: "connection_missing" };

/**
 * The reachable arms of a review or clear. Narrowed on purpose: the compiler
 * then proves the route handles exactly what the mutation can return, and
 * `drifted`/`unreviewed` are unrepresentable results of a write.
 */
export type McpToolPolicyReviewState = Extract<
  McpToolPolicyState,
  { status: "reviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

export type McpToolPolicyClearState = Extract<
  McpToolPolicyState,
  { status: "unreviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

type UnresolvedIdentity = Extract<McpToolIdentityResolution, { status: "unresolved" }>;

/**
 * The three arms an unresolved identity maps to. A subtype of both the review
 * and clear results, so a mutation can return the mapper's value directly and
 * the compiler proves the route handles it.
 */
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

/** The unresolved arm's reason, as the product-facing state it maps to. */
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

/**
 * Lock the owned connection row before any identity read. Returns false when no
 * owned connection matches; the caller answers `connection_missing`. The lock is
 * the whole point: a concurrent catalog publication serializes behind it, so the
 * revision cannot move between the resolver read and the policy write.
 */
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

/**
 * The most recently touched review for `(connection, remoteName)` under ANY
 * descriptor hash. Only read to populate `drifted`'s `previous`; it is a
 * product read, not a second identity derivation, so it does not compete with
 * the resolver's authority.
 */
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

/**
 * The reviewed state of one exact tool. Pure read: it resolves the identity,
 * classifies the exact-descriptor row, and reports the unresolved reason. A
 * review that exists under a DIFFERENT descriptor is `drifted`, because the
 * gate keeps the floor for it (ADR-0096: a reviewed call wins in both
 * directions, so drift must re-gate rather than fall through to the structural
 * downgrade).
 */
export async function readMcpToolPolicyState(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpToolPolicyState> {
  const identity = await resolveMcpToolIdentity(identityInput(input), runner);

  if (identity.status === "unresolved") return policyStateFromUnresolved(identity);

  if (identity.policy !== undefined) return { status: "reviewed", policy: identity.policy };

  if (!identity.reviewed) return { status: "unreviewed" };

  const previous = await readLatestPairPolicy(input, runner);

  // `reviewed` was true and the pair read now finds nothing: a concurrent clear
  // landed between the two reads. The truth is now "unreviewed", which is the
  // state this read reports.
  if (previous === undefined) return { status: "unreviewed" };

  return { status: "drifted", previous };
}

/**
 * Write the owner's review for the descriptor they inspected.
 *
 * Runs in one transaction under the connection-row lock so the revision cannot
 * move between resolve and write. `policyRevision` is server-owned and
 * monotonic: it is the exact-descriptor row's current revision plus one, so a
 * re-review of the same descriptor bumps it and a first review starts at one.
 */
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
        // The SERVER's hash. The caller never supplies one, so a review cannot
        // be written under a descriptor it did not name.
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
 * Clear every review for `(connection, remoteName)`, not only the current
 * descriptor's row.
 *
 * The resolver's `reviewed` flag is hash-blind, so deleting only the exact-hash
 * row would leave it true and the ADR-0096 structural downgrade could never
 * return. Clearing the pair is what "the owner no longer reviews this tool"
 * means. The ref is still resolved first so a stale revision answers
 * `catalog_stale` rather than silently clearing a review the caller was looking
 * at under a different catalog.
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
