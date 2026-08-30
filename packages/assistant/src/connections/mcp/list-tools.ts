/**
 * Bounded, local discovery over persisted MCP catalogs. This module owns the
 * scan budget and cursor semantics; it never reaches a live MCP client.
 */

import {
  Errors,
  getStringPath,
  isApiError,
  jsonObjectSchema,
  MCP_LIST_TOOLS_DEFAULT_LIMIT,
  MCP_LIST_TOOLS_MAX_LIMIT,
  mcpExternalToolRefSchema,
  mcpToolDiscoveryPageSchema,
  mcpToolInspectionResultSchema,
  mcpToolSearchInputSchema,
  summarizeBody,
  type ExternalToolRef,
  type McpDiscoveryConnection,
  type McpListToolsDetail,
  type McpToolDiscoveryHit,
  type McpToolDiscoveryPage,
  type McpToolInspectionResult,
  type McpToolSearchInput,
} from "@alfred/contracts";
import { z } from "zod";
import { sha256Canonical } from "./hash";
import {
  listOwnedCurrentCatalogs,
  readOwnedCurrentCatalog,
  type OwnedCurrentCatalogPosition,
  type OwnedCurrentCatalogRow,
} from "./persistence";

const MAX_SUMMARY_DESCRIPTION_CHARS = 240;
const MAX_CATALOGS_SCANNED = 4;
const MAX_DESCRIPTORS_SCANNED = 200;

const cursorPositionSchema = z
  .object({
    namespace: z.string().min(1),
    instanceKey: z.string().min(1),
    connectionId: z.string().min(1),
    catalogRevision: z.string().min(1),
    descriptorOffset: z.number().int().nonnegative(),
  })
  .strict();

const discoveryCursorSchema = z
  .object({
    v: z.literal(1),
    filterHash: z.string().min(1),
    position: cursorPositionSchema,
  })
  .strict();

type DiscoveryCursor = z.infer<typeof discoveryCursorSchema>;

interface Summary {
  remoteName: string;
  title?: string;
  description?: string;
}

interface NormalizedSearch {
  query: string;
  namespace?: string;
  connectionId?: string;
  detail: McpListToolsDetail;
  limit: number;
}

function normalizeSearch(input: McpToolSearchInput): NormalizedSearch {
  return {
    query: input.query?.trim().toLowerCase() ?? "",
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    detail: input.detail ?? "summary",
    limit: Math.min(input.limit ?? MCP_LIST_TOOLS_DEFAULT_LIMIT, MCP_LIST_TOOLS_MAX_LIMIT),
  };
}

function filterHash(input: NormalizedSearch): string {
  return sha256Canonical({
    query: input.query,
    namespace: input.namespace ?? null,
    connectionId: input.connectionId ?? null,
    detail: input.detail,
  });
}

function cursorError(message: string): never {
  throw Errors.BadRequestError(`Invalid MCP discovery cursor: ${message}`);
}

function decodeCursor(
  encoded: string | undefined,
  expectedFilterHash: string,
): DiscoveryCursor | null {
  if (!encoded) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const cursor = discoveryCursorSchema.parse(decoded);
    if (cursor.filterHash !== expectedFilterHash) cursorError("filters changed");
    return cursor;
  } catch (error) {
    if (isApiError(error, "BAD_REQUEST")) throw error;
    return cursorError("malformed value");
  }
}

function encodeCursor(
  filter: string,
  row: OwnedCurrentCatalogRow,
  descriptorOffset: number,
): string {
  const cursor: DiscoveryCursor = {
    v: 1,
    filterHash: filter,
    position: {
      namespace: row.namespace,
      instanceKey: row.instanceKey,
      connectionId: row.connectionId,
      catalogRevision: row.revisionHash,
      descriptorOffset,
    },
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function descriptors(row: OwnedCurrentCatalogRow): unknown[] {
  return Array.isArray(row.descriptors) ? row.descriptors : [];
}

/** Project one persisted, previously validated descriptor into visible bounded text. */
function toSummary(descriptor: unknown): Summary | undefined {
  const parsed = jsonObjectSchema.safeParse(descriptor);
  if (!parsed.success) return undefined;
  const remoteName = getStringPath(parsed.data, "name");
  if (!remoteName) return undefined;
  const title = getStringPath(parsed.data, "title");
  const rawDescription = getStringPath(parsed.data, "description");
  const description = rawDescription
    ? summarizeBody(rawDescription, MAX_SUMMARY_DESCRIPTION_CHARS)
    : undefined;
  return {
    remoteName,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function connection(row: OwnedCurrentCatalogRow): McpDiscoveryConnection {
  return { id: row.connectionId, instanceKey: row.instanceKey, label: row.label };
}

function matches(summary: Summary, row: OwnedCurrentCatalogRow, query: string): boolean {
  if (!query) return true;
  return [row.label, summary.remoteName, summary.title, summary.description].some((value) =>
    value?.toLowerCase().includes(query),
  );
}

function hit(
  row: OwnedCurrentCatalogRow,
  summary: Summary,
  detail: McpListToolsDetail,
): McpToolDiscoveryHit {
  return {
    ref: {
      kind: "mcp",
      connectionId: row.connectionId,
      remoteName: summary.remoteName,
      catalogRevision: row.revisionHash,
    },
    namespace: row.namespace,
    connection: connection(row),
    ...(detail === "summary" && summary.title ? { title: summary.title } : {}),
    ...(detail === "summary" && summary.description ? { description: summary.description } : {}),
  };
}

function positionOf(row: OwnedCurrentCatalogRow): OwnedCurrentCatalogPosition {
  return {
    namespace: row.namespace,
    instanceKey: row.instanceKey,
    connectionId: row.connectionId,
  };
}

async function rowsForSearch(input: {
  userId: string;
  namespace?: string;
  connectionId?: string;
  cursor: DiscoveryCursor | null;
}): Promise<{ rows: OwnedCurrentCatalogRow[]; firstOffset: number; fullBatch: boolean }> {
  if (!input.cursor) {
    const rows = await listOwnedCurrentCatalogs({
      userId: input.userId,
      ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      limit: MAX_CATALOGS_SCANNED,
    });
    return { rows, firstOffset: 0, fullBatch: rows.length === MAX_CATALOGS_SCANNED };
  }

  const current = await readOwnedCurrentCatalog({
    userId: input.userId,
    connectionId: input.cursor.position.connectionId,
  });
  if (
    !current ||
    current.namespace !== input.cursor.position.namespace ||
    current.instanceKey !== input.cursor.position.instanceKey ||
    (input.namespace !== undefined && current.namespace !== input.namespace) ||
    (input.connectionId !== undefined && current.connectionId !== input.connectionId)
  ) {
    cursorError("catalog position is no longer available");
  }
  if (current.revisionHash !== input.cursor.position.catalogRevision) {
    cursorError("catalog revision changed");
  }
  if (input.cursor.position.descriptorOffset > descriptors(current).length) {
    cursorError("descriptor position is outside the catalog");
  }

  const remainingBudget = MAX_CATALOGS_SCANNED - 1;
  const following = await listOwnedCurrentCatalogs({
    userId: input.userId,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    after: positionOf(current),
    limit: remainingBudget,
  });
  return {
    rows: [current, ...following],
    firstOffset: input.cursor.position.descriptorOffset,
    fullBatch: following.length === remainingBudget,
  };
}

export async function searchMcpToolsLocal(
  input: McpToolSearchInput & { userId: string },
): Promise<McpToolDiscoveryPage> {
  const { userId, ...searchInput } = input;
  const parsed = mcpToolSearchInputSchema.parse(searchInput);
  const normalized = normalizeSearch(parsed);
  const expectedFilterHash = filterHash(normalized);
  const cursor = decodeCursor(parsed.cursor, expectedFilterHash);
  const { rows, firstOffset, fullBatch } = await rowsForSearch({
    userId,
    ...(normalized.namespace === undefined ? {} : { namespace: normalized.namespace }),
    ...(normalized.connectionId === undefined ? {} : { connectionId: normalized.connectionId }),
    cursor,
  });

  const tools: McpToolDiscoveryHit[] = [];
  let scanned = 0;
  let lastRow: OwnedCurrentCatalogRow | undefined;
  let lastOffset = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const catalog = descriptors(row);
    const start = rowIndex === 0 ? firstOffset : 0;
    lastRow = row;
    lastOffset = start;

    for (let index = start; index < catalog.length; index += 1) {
      if (scanned >= MAX_DESCRIPTORS_SCANNED) {
        return mcpToolDiscoveryPageSchema.parse({
          status: "tools",
          tools,
          nextCursor: encodeCursor(expectedFilterHash, row, index),
        });
      }
      scanned += 1;
      lastOffset = index + 1;
      const summary = toSummary(catalog[index]);
      if (summary && matches(summary, row, normalized.query)) {
        tools.push(hit(row, summary, normalized.detail));
      }
      if (tools.length >= normalized.limit) {
        const hasUnscannedScope =
          index + 1 < catalog.length || rowIndex + 1 < rows.length || fullBatch;
        return mcpToolDiscoveryPageSchema.parse({
          status: "tools",
          tools,
          nextCursor: hasUnscannedScope ? encodeCursor(expectedFilterHash, row, index + 1) : null,
        });
      }
    }
  }

  return mcpToolDiscoveryPageSchema.parse({
    status: "tools",
    tools,
    nextCursor: fullBatch && lastRow ? encodeCursor(expectedFilterHash, lastRow, lastOffset) : null,
  });
}

export async function inspectMcpToolLocal(input: {
  userId: string;
  ref: ExternalToolRef;
}): Promise<McpToolInspectionResult> {
  const ref = mcpExternalToolRefSchema.parse(input.ref);
  const row = await readOwnedCurrentCatalog({
    userId: input.userId,
    connectionId: ref.connectionId,
  });
  if (!row) {
    return mcpToolInspectionResultSchema.parse({
      status: "not_found",
      ref,
      message: "This MCP tool is not available for the current user.",
    });
  }
  if (row.revisionHash !== ref.catalogRevision) {
    return mcpToolInspectionResultSchema.parse({
      status: "catalog_stale",
      ref,
      message: "The MCP catalog changed. Search again and select a current tool reference.",
    });
  }

  const tool = descriptors(row)
    .map((descriptor) => jsonObjectSchema.safeParse(descriptor))
    .find((descriptor) => descriptor.success && descriptor.data.name === ref.remoteName);
  if (!tool?.success) {
    return mcpToolInspectionResultSchema.parse({
      status: "not_found",
      ref,
      message: `MCP tool '${ref.remoteName}' is not in the current catalog.`,
    });
  }
  return mcpToolInspectionResultSchema.parse({
    status: "tool",
    ref,
    connection: connection(row),
    tool: tool.data,
  });
}
