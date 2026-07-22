/**
 * `mcp.list_tools` — a bounded, LOCAL read of a connection's already-validated
 * catalog (issue #540 clarification #5). It never touches the network and never
 * dumps the raw client's 1 MB / 1,000-tool ceiling into one result: compact
 * summaries by default, paginated, with a bounded single full descriptor only
 * when the caller names one tool.
 *
 * The catalog is read from the persisted current revision (`persistence.ts`), not
 * a live fetch, and is scoped to the calling user — a model-supplied
 * `connectionId` that is not owned by the caller reads as "not found", never
 * another user's catalog.
 */

import {
  getStringPath,
  isRecord,
  MCP_LIST_TOOLS_DEFAULT_LIMIT,
  MCP_LIST_TOOLS_MAX_LIMIT,
  summarizeBody,
  type McpListToolsInput,
} from "@alfred/contracts";
import { readConnection, readRevisionById } from "./persistence";

const MAX_SUMMARY_DESCRIPTION_CHARS = 240;

export interface McpToolSummary {
  name: string;
  title?: string;
  description?: string;
}

export type McpListToolsResult =
  | {
      status: "not_found";
      connectionId: string;
      message: string;
    }
  | {
      status: "empty";
      connectionId: string;
      message: string;
    }
  | {
      status: "tool";
      connectionId: string;
      catalogRevision: string;
      /** The bounded full descriptor for the one named tool (already ≤128 KB at ingest). */
      tool: unknown;
      /** True when the caller's echoed revision no longer matches the live view. */
      catalogChanged: boolean;
    }
  | {
      status: "tools";
      connectionId: string;
      catalogRevision: string;
      toolCount: number;
      tools: McpToolSummary[];
      /** Opaque offset cursor for the next page, when more remain. */
      nextCursor?: string;
      catalogChanged: boolean;
    };

/** Narrow a persisted descriptor (`unknown` jsonb) to a compact, bounded summary. */
function toSummary(descriptor: unknown): McpToolSummary | undefined {
  if (!isRecord(descriptor)) return undefined;
  const name = descriptor.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const title = getStringPath(descriptor, "title");
  const description = getStringPath(descriptor, "description");
  return {
    name,
    ...(title ? { title } : {}),
    ...(description
      ? { description: summarizeBody(description, MAX_SUMMARY_DESCRIPTION_CHARS) }
      : {}),
  };
}

/** Parse the opaque cursor to a non-negative offset; anything invalid → 0. */
function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function listMcpToolsLocal(
  input: McpListToolsInput,
  userId: string,
): Promise<McpListToolsResult> {
  const connection = await readConnection(input.connectionId);
  // Ownership scope: a connection the caller does not own is indistinguishable
  // from one that does not exist.
  if (!connection || connection.userId !== userId) {
    return {
      status: "not_found",
      connectionId: input.connectionId,
      message: `No connected MCP server '${input.connectionId}'.`,
    };
  }

  // Reuse the connection already in hand rather than re-reading it via
  // `readCurrentRevision` (which would refetch the same row).
  const revision = connection.currentCatalogRevisionId
    ? await readRevisionById(connection.currentCatalogRevisionId)
    : undefined;
  if (!revision) {
    return {
      status: "empty",
      connectionId: input.connectionId,
      message: "This MCP connection has no catalog yet — connect and refresh it first.",
    };
  }

  const descriptors = Array.isArray(revision.descriptors) ? revision.descriptors : [];
  const catalogChanged = Boolean(
    input.catalogRevision && input.catalogRevision !== revision.revisionHash,
  );

  // Single-tool detail: the one bounded full descriptor.
  if (input.remoteName) {
    const match = descriptors.find(
      (descriptor) => isRecord(descriptor) && descriptor.name === input.remoteName,
    );
    if (!match) {
      return {
        status: "not_found",
        connectionId: input.connectionId,
        message: `MCP tool '${input.remoteName}' is not in the current catalog.`,
      };
    }
    return {
      status: "tool",
      connectionId: input.connectionId,
      catalogRevision: revision.revisionHash,
      tool: match,
      catalogChanged,
    };
  }

  // Compact, filtered, paginated summaries.
  const query = input.query?.trim().toLowerCase();
  const summaries = descriptors
    .map(toSummary)
    .filter((summary): summary is McpToolSummary => summary !== undefined)
    .filter((summary) =>
      query
        ? summary.name.toLowerCase().includes(query) ||
          (summary.description?.toLowerCase().includes(query) ?? false)
        : true,
    );

  const limit = Math.min(input.limit ?? MCP_LIST_TOOLS_DEFAULT_LIMIT, MCP_LIST_TOOLS_MAX_LIMIT);
  const offset = parseCursor(input.cursor);
  const page = summaries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    status: "tools",
    connectionId: input.connectionId,
    catalogRevision: revision.revisionHash,
    toolCount: summaries.length,
    tools: page,
    ...(nextOffset < summaries.length ? { nextCursor: String(nextOffset) } : {}),
    catalogChanged,
  };
}
