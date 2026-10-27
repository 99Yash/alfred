/** Bounded search over stored MCP catalogs. Never calls a live client. */

import {
  Errors,
  jsonObjectSchema,
  MCP_LIST_TOOLS_DEFAULT_LIMIT,
  MCP_LIST_TOOLS_MAX_LIMIT,
  mcpExternalToolRefSchema,
  mcpToolDiscoveryPageSchema,
  mcpToolInspectionResultSchema,
  mcpToolSearchInputSchema,
  parseJsonWith,
  summarizeBody,
  type ExternalToolRef,
  type McpDiscoveryConnection,
  type McpListToolsDetail,
  type McpToolDiscoveryHit,
  type McpToolDiscoveryPage,
  type McpToolInspectionResult,
  type McpToolSearchInput,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";
import { z } from "zod";
import { catalogWords } from "./catalog-query";
import { MCP_DISCOVERY_SCAN_BUDGET } from "./discovery-policy";
import {
  listOwnedCurrentCatalogSlices,
  readOwnedCurrentCatalogDescriptor,
  readOwnedCurrentCatalogSlice,
  type OwnedCurrentCatalogPosition,
  type OwnedCurrentCatalogRow,
  type OwnedCurrentCatalogSliceRow,
} from "./persistence";

const MAX_SUMMARY_DESCRIPTION_CHARS = 240;

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

  const cursor = parseJsonWith(
    Buffer.from(encoded, "base64url").toString("utf8"),
    discoveryCursorSchema,
  );

  if (!cursor) return cursorError("malformed value");

  if (cursor.filterHash !== expectedFilterHash) cursorError("filters changed");

  return cursor;
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

/** Turn one stored summary into bounded text. */
function toSummary(
  stored: OwnedCurrentCatalogSliceRow["summaries"][number] | undefined,
): Summary | undefined {
  if (!stored) return undefined;
  const { title } = stored;

  const description = stored.description
    ? summarizeBody(stored.description, MAX_SUMMARY_DESCRIPTION_CHARS)
    : undefined;

  return {
    remoteName: stored.name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function connection(row: OwnedCurrentCatalogRow): McpDiscoveryConnection {
  return { id: row.connectionId, instanceKey: row.instanceKey, label: row.label };
}

/**
 * Match tool fields only. The whole query can occur as one substring, or each query word can
 * start a word of the tool's name, title, or description ("deploy" finds `list-deployments`).
 * A word that names the connection is skipped, so "railway variables" finds `list-variables`.
 * A query of label words only matches nothing: it would return every tool on the connection,
 * and `namespace` or `connectionId` is the door that scopes a search to one connection.
 */
function matches(
  summary: Summary,
  row: OwnedCurrentCatalogRow,
  query: string,
  queryWords: ReadonlySet<string>,
): boolean {
  if (!query) return true;

  const fields = [summary.remoteName, summary.title, summary.description];

  if (fields.some((value) => value?.toLowerCase().includes(query))) return true;

  // Strip the full label here; only ranking excludes generic words such as "MCP".
  const labelWords = catalogWords(row.label);
  const wanted = [...queryWords].filter((word) => !labelWords.has(word));

  if (wanted.length === 0) return false;

  const toolWords = [...catalogWords(fields.filter((value) => value !== undefined).join(" "))];

  return wanted.every((word) => toolWords.some((toolWord) => toolWord.startsWith(word)));
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
}): Promise<{ rows: OwnedCurrentCatalogSliceRow[]; hasMore: boolean }> {
  if (!input.cursor) {
    return listOwnedCurrentCatalogSlices({
      userId: input.userId,
      ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      catalogLimit: MCP_DISCOVERY_SCAN_BUDGET.catalogLimit,
      descriptorLimit: MCP_DISCOVERY_SCAN_BUDGET.descriptorLimit,
    });
  }

  const current = await readOwnedCurrentCatalogSlice({
    userId: input.userId,
    connectionId: input.cursor.position.connectionId,
    descriptorOffset: input.cursor.position.descriptorOffset,
    descriptorLimit: MCP_DISCOVERY_SCAN_BUDGET.descriptorLimit,
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

  if (input.cursor.position.descriptorOffset > current.descriptorCount) {
    cursorError("descriptor position is outside the catalog");
  }

  const remainingDescriptorBudget =
    MCP_DISCOVERY_SCAN_BUDGET.descriptorLimit - current.summaries.length;

  // The budget is spent, so the next read only checks whether more catalogs exist.
  const remainingCatalogBudget =
    remainingDescriptorBudget === 0 ? 0 : MCP_DISCOVERY_SCAN_BUDGET.catalogLimit - 1;

  const following = await listOwnedCurrentCatalogSlices({
    userId: input.userId,
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    after: positionOf(current),
    catalogLimit: remainingCatalogBudget,
    descriptorLimit: remainingDescriptorBudget,
  });

  return { rows: [current, ...following.rows], hasMore: following.hasMore };
}

/** Search stored catalogs. */
export async function searchMcpToolsLocal(
  input: McpToolSearchInput & { userId: string },
): Promise<McpToolDiscoveryPage> {
  const { userId, ...searchInput } = input;
  const parsed = mcpToolSearchInputSchema.parse(searchInput);
  const normalized = normalizeSearch(parsed);
  const expectedFilterHash = filterHash(normalized);
  const cursor = decodeCursor(parsed.cursor, expectedFilterHash);

  const { rows, hasMore } = await rowsForSearch({
    userId,
    ...(normalized.namespace === undefined ? {} : { namespace: normalized.namespace }),
    ...(normalized.connectionId === undefined ? {} : { connectionId: normalized.connectionId }),
    cursor,
  });

  const queryWords = catalogWords(normalized.query);
  const tools: McpToolDiscoveryHit[] = [];
  let scanned = 0;
  let lastRow: OwnedCurrentCatalogRow | undefined;
  let lastOffset = 0;

  for (const [rowIndex, row] of rows.entries()) {
    const catalog = row.summaries;
    const start = row.descriptorOffset;
    lastRow = row;
    lastOffset = start;

    for (let localIndex = 0; localIndex < catalog.length; localIndex += 1) {
      const descriptorOffset = start + localIndex;

      if (scanned >= MCP_DISCOVERY_SCAN_BUDGET.descriptorLimit) {
        return mcpToolDiscoveryPageSchema.parse({
          status: "tools",
          tools,
          nextCursor: encodeCursor(expectedFilterHash, row, descriptorOffset),
        });
      }

      scanned += 1;
      lastOffset = descriptorOffset + 1;
      const summary = toSummary(catalog[localIndex]);

      if (summary && matches(summary, row, normalized.query, queryWords)) {
        tools.push(hit(row, summary, normalized.detail));
      }

      if (tools.length >= normalized.limit) {
        const hasUnscannedScope =
          lastOffset < row.descriptorCount || rowIndex + 1 < rows.length || hasMore;

        return mcpToolDiscoveryPageSchema.parse({
          status: "tools",
          tools,
          nextCursor: hasUnscannedScope ? encodeCursor(expectedFilterHash, row, lastOffset) : null,
        });
      }
    }

    if (lastOffset < row.descriptorCount) {
      return mcpToolDiscoveryPageSchema.parse({
        status: "tools",
        tools,
        nextCursor: encodeCursor(expectedFilterHash, row, lastOffset),
      });
    }
  }

  return mcpToolDiscoveryPageSchema.parse({
    status: "tools",
    tools,
    nextCursor: hasMore && lastRow ? encodeCursor(expectedFilterHash, lastRow, lastOffset) : null,
  });
}

export async function inspectMcpToolLocal(input: {
  userId: string;
  ref: ExternalToolRef;
}): Promise<McpToolInspectionResult> {
  const ref = mcpExternalToolRefSchema.parse(input.ref);

  const row = await readOwnedCurrentCatalogDescriptor({
    userId: input.userId,
    connectionId: ref.connectionId,
    remoteName: ref.remoteName,
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

  // The read selects by name, so a mismatch here is a bug.
  const tool = jsonObjectSchema.safeParse(row.descriptor);

  if (!tool.success || tool.data.name !== ref.remoteName) {
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
