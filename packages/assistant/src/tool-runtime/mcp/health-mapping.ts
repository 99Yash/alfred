/**
 * Owner-reviewed MCP health mappings: which read may feed the object-state store.
 * Same binding as policy reviews (ADR-0088): exact descriptor, connection-row lock,
 * `catalog_stale` on a moved revision. A row under an old hash is inert.
 */

import {
  isBuiltInObjectStateProvider,
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
  isReadOnlyMcpToolIdentity,
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type ResolveMcpToolIdentityInput,
} from "./invocations";

type UnresolvedIdentity = Extract<McpToolIdentityResolution, { status: "unresolved" }>;

export type McpHealthMappingResolution =
  | { status: "reviewed"; mapping: McpHealthMapping }
  | { status: "unreviewed" }
  | { status: "drifted"; previous: McpHealthMapping }
  | { status: "invalid" }
  | { status: "catalog_stale" }
  | { status: "not_found" }
  | { status: "not_read_only" }
  | { status: "connection_missing" };

export type McpHealthMappingReviewState = Extract<
  McpHealthMappingResolution,
  {
    status:
      | "reviewed"
      | "invalid"
      | "catalog_stale"
      | "not_found"
      | "not_read_only"
      | "connection_missing";
  }
>;

export type McpHealthMappingClearState = Extract<
  McpHealthMappingResolution,
  { status: "unreviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

type McpHealthMappingUnresolvedState = Extract<
  McpHealthMappingResolution,
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

  if (!definition.success || isBuiltInObjectStateProvider(definition.data.identityProvider)) {
    return null;
  }

  const mapping = mcpHealthMappingSchema.safeParse({
    definition: definition.data,
    note: row.reviewedNote,
    mappingRevision: row.mappingRevision,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  });

  return mapping.success ? mapping.data : null;
}

/** Read the current review, a drifted predecessor, or the reason there is none. */
export async function readMcpHealthMappingState(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpHealthMappingResolution> {
  const identity = await resolveMcpToolIdentity(identityInput(input), runner);

  if (identity.status === "unresolved") return stateFromUnresolved(identity);

  if (!isReadOnlyMcpToolIdentity(identity)) return { status: "not_read_only" };

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

/** Write the owner's mapping for the exact descriptor named by `ref`. */
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

    // The published descriptor decides read-only, not the owner's checkbox.
    // Built-in providers own their object state, so no MCP mapping for them.
    if (input.readOnly !== true || !isReadOnlyMcpToolIdentity(identity)) {
      return { status: "not_read_only" };
    }

    if (isBuiltInObjectStateProvider(definition.identityProvider)) {
      return { status: "invalid" };
    }

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
