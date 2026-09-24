/**
 * Owner-reviewed MCP health mappings (#1196).
 *
 * The authority shape is deliberately the ADR-0088 policy-review shape: the
 * owner names an exact `(connection, remoteName, catalogRevision)`, the server
 * re-derives the current descriptor hash under that revision, and the write is
 * serialized on the owned connection row. A catalog publication between inspect
 * and save therefore answers `catalog_stale`; after publication, a row under an
 * older descriptor hash no longer resolves and is inert (VOID).
 *
 * This module is separate from `mcp_tool_policy` because the decisions are
 * different: a policy says how a model-selected call is approved/retried; a
 * health mapping says how one owner-reviewed gather-time read may enter the
 * deterministic object-state store. Neither can stand in for the other.
 */

import {
  mcpHealthMappingDefinitionSchema,
  mcpHealthMappingSchema,
  type ExternalToolRef,
  type McpHealthMapping,
  type McpHealthMappingDefinition,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import { mcpConnections, mcpHealthMapping, type McpHealthMappingRow } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import {
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type ResolveMcpToolIdentityInput,
} from "./invocations";

type UnresolvedIdentity = Extract<McpToolIdentityResolution, { status: "unresolved" }>;

export type McpHealthMappingState =
  | { status: "reviewed"; mapping: McpHealthMapping }
  | { status: "unreviewed" }
  | { status: "drifted"; previous: McpHealthMapping }
  | { status: "invalid" }
  | { status: "catalog_stale" }
  | { status: "not_found" }
  | { status: "connection_missing" };

export type McpHealthMappingReviewState = Extract<
  McpHealthMappingState,
  { status: "reviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

export type McpHealthMappingClearState = Extract<
  McpHealthMappingState,
  { status: "unreviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

type McpHealthMappingUnresolvedState = Extract<
  McpHealthMappingState,
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

function stateFromUnresolved(identity: UnresolvedIdentity): McpHealthMappingUnresolvedState {
  switch (identity.reason) {
    case "connection_missing":
      return { status: "connection_missing" };
    case "revision_stale":
      return { status: "catalog_stale" };
    case "descriptor_missing":
      return { status: "not_found" };
  }
}

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

async function readExactMapping(
  input: { userId: string; connectionId: string; remoteName: string; descriptorHash: string },
  runner: DbRunner,
): Promise<McpHealthMappingRow | undefined> {
  const [row] = await runner
    .select()
    .from(mcpHealthMapping)
    .where(
      and(
        eq(mcpHealthMapping.userId, input.userId),
        eq(mcpHealthMapping.connectionId, input.connectionId),
        eq(mcpHealthMapping.remoteName, input.remoteName),
        eq(mcpHealthMapping.descriptorHash, input.descriptorHash),
      ),
    )
    .limit(1);

  return row;
}

async function readLatestPairMapping(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner,
): Promise<McpHealthMappingRow | undefined> {
  const [row] = await runner
    .select()
    .from(mcpHealthMapping)
    .where(
      and(
        eq(mcpHealthMapping.userId, input.userId),
        eq(mcpHealthMapping.connectionId, input.ref.connectionId),
        eq(mcpHealthMapping.remoteName, input.ref.remoteName),
      ),
    )
    .orderBy(desc(mcpHealthMapping.updatedAt), desc(mcpHealthMapping.id))
    .limit(1);

  return row;
}

function mappingFromRow(row: McpHealthMappingRow): McpHealthMapping | null {
  const definition = mcpHealthMappingDefinitionSchema.safeParse(row.definition);

  if (!definition.success) return null;

  const mapping = mcpHealthMappingSchema.safeParse({
    definition: definition.data,
    note: row.reviewedNote,
    mappingRevision: row.mappingRevision,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  });

  return mapping.success ? mapping.data : null;
}

/** Read the exact current review, a drifted predecessor, or an honest refusal. */
export async function readMcpHealthMappingState(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpHealthMappingState> {
  const identity = await resolveMcpToolIdentity(identityInput(input), runner);

  if (identity.status === "unresolved") return stateFromUnresolved(identity);

  const exact = await readExactMapping(
    {
      userId: input.userId,
      connectionId: input.ref.connectionId,
      remoteName: input.ref.remoteName,
      descriptorHash: identity.descriptorHash,
    },
    runner,
  );

  if (exact) {
    const mapping = mappingFromRow(exact);

    return mapping ? { status: "reviewed", mapping } : { status: "invalid" };
  }

  const previousRow = await readLatestPairMapping(input, runner);

  if (!previousRow) return { status: "unreviewed" };

  const previous = mappingFromRow(previousRow);

  return previous ? { status: "drifted", previous } : { status: "invalid" };
}

/**
 * Write the owner's mapping for the exact descriptor named by `ref`.
 * `readOnly: true` is already literal at the wire boundary; the review row's
 * existence is the durable attestation, never an inference from tool text.
 */
export async function reviewMcpHealthMapping(
  input: {
    userId: string;
    ref: ExternalToolRef;
    readOnly: true;
    definition: McpHealthMappingDefinition;
    note: string | null;
  },
  runner: DbRunner = db(),
): Promise<McpHealthMappingReviewState> {
  const definition = mcpHealthMappingDefinitionSchema.parse(input.definition);

  return runAtomic(runner, async (tx) => {
    if (!(await lockOwnedConnection(tx, input.userId, input.ref.connectionId))) {
      return { status: "connection_missing" };
    }

    const identity = await resolveMcpToolIdentity(identityInput(input), tx);

    if (identity.status === "unresolved") return stateFromUnresolved(identity);

    const previous = await readExactMapping(
      {
        userId: input.userId,
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        descriptorHash: identity.descriptorHash,
      },
      tx,
    );

    const reviewedAt = new Date();

    const [row] = await tx
      .insert(mcpHealthMapping)
      .values({
        userId: input.userId,
        connectionId: input.ref.connectionId,
        remoteName: input.ref.remoteName,
        descriptorHash: identity.descriptorHash,
        mappingRevision: (previous?.mappingRevision ?? 0) + 1,
        definition,
        reviewedAt,
        reviewedNote: input.note,
      })
      .onConflictDoUpdate({
        target: [
          mcpHealthMapping.connectionId,
          mcpHealthMapping.remoteName,
          mcpHealthMapping.descriptorHash,
        ],
        set: {
          mappingRevision: (previous?.mappingRevision ?? 0) + 1,
          definition,
          reviewedAt,
          reviewedNote: input.note,
        },
      })
      .returning();

    const savedRow = requireRow(row, "reviewMcpHealthMapping");

    const saved = mcpHealthMappingSchema.parse({
      definition,
      note: savedRow.reviewedNote,
      mappingRevision: savedRow.mappingRevision,
      reviewedAt: savedRow.reviewedAt?.toISOString() ?? null,
    });

    return { status: "reviewed", mapping: saved };
  });
}

/** Clear every descriptor review for the pair, matching `clearMcpToolPolicy`. */
export async function clearMcpHealthMapping(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpHealthMappingClearState> {
  return runAtomic(runner, async (tx) => {
    if (!(await lockOwnedConnection(tx, input.userId, input.ref.connectionId))) {
      return { status: "connection_missing" };
    }

    const identity = await resolveMcpToolIdentity(identityInput(input), tx);

    if (identity.status === "unresolved") return stateFromUnresolved(identity);

    await tx
      .delete(mcpHealthMapping)
      .where(
        and(
          eq(mcpHealthMapping.userId, input.userId),
          eq(mcpHealthMapping.connectionId, input.ref.connectionId),
          eq(mcpHealthMapping.remoteName, input.ref.remoteName),
        ),
      );

    return { status: "unreviewed" };
  });
}
