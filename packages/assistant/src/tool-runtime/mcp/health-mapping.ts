/**
 * Owner-reviewed MCP health mappings: which read may feed the object-state store.
 * Same binding as policy reviews (ADR-0088): exact descriptor, connection-row lock,
 * `catalog_stale` on a moved revision. A row under an old hash is inert.
 */

import {
  mcpHealthMappingDefinitionSchema,
  mcpHealthMappingSchema,
  type ExternalToolRef,
  type McpHealthMapping,
  type McpHealthMappingDefinition,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { requireRow, runAtomic, type DbRunner } from "@alfred/db/helpers";
import { mcpHealthMapping, type McpHealthMappingRow } from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import {
  isReadOnlyMcpToolIdentity,
  lockMcpReviewTarget,
  resolveMcpReviewTarget,
} from "./invocations";

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
    status: "reviewed" | "catalog_stale" | "not_found" | "not_read_only" | "connection_missing";
  }
>;

export type McpHealthMappingClearState = Extract<
  McpHealthMappingResolution,
  { status: "unreviewed" | "catalog_stale" | "not_found" | "connection_missing" }
>;

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

/** Read the current review, a drifted predecessor, or the reason there is none. */
export async function readMcpHealthMappingState(
  input: { userId: string; ref: ExternalToolRef },
  runner: DbRunner = db(),
): Promise<McpHealthMappingResolution> {
  const identity = await resolveMcpReviewTarget(input, runner);

  if (identity.status !== "resolved") return identity;

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
    const identity = await lockMcpReviewTarget(tx, input);

    if (identity.status !== "resolved") return identity;

    // The published descriptor decides read-only, not the owner's checkbox.
    if (!isReadOnlyMcpToolIdentity(identity)) {
      return { status: "not_read_only" };
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
    const identity = await lockMcpReviewTarget(tx, input);

    if (identity.status !== "resolved") return identity;

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
