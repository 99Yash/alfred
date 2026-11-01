import { z } from "zod";
import { INTEGRATION_SLUGS, type IntegrationSlug } from "./integrations";

/**
 * The one name of a source in every layer (ADR-0118 decision 2): the activity record, object
 * state, documents, and Context Search. A known MCP server resolves to its registry slug. A server
 * that the user added is named by its `mcp_servers.id`, never by the name it reports.
 */

declare const mcpServerIdBrand: unique symbol;

/** An `mcp_servers.id`. It stays the same across reconnects, so it can key stored rows. */
export type McpServerId = string & { readonly [mcpServerIdBrand]: true };

/** `createId("mcps")`: the prefix, `_`, then 12 of `[0-9a-z]`. */
const MCP_SERVER_ID_RE = /^mcps_[0-9a-z]{12}$/;

function isMcpServerId(value: string): value is McpServerId {
  return MCP_SERVER_ID_RE.test(value);
}

// Annotated, so a package that emits declarations can name the brand (TS4023).
const mcpServerIdSchema: z.ZodType<McpServerId, string> = z
  .string()
  .refine(isMcpServerId, { error: "not an mcp_servers id" });

export type SourceIdentity =
  | { readonly kind: "integration"; readonly slug: IntegrationSlug }
  | { readonly kind: "custom_mcp"; readonly serverId: McpServerId };

/** The parser at every boundary that reads a stored source identity. */
export const sourceIdentitySchema: z.ZodType<SourceIdentity, unknown> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("integration"), slug: z.enum(INTEGRATION_SLUGS) }).strict(),
    z.object({ kind: z.literal("custom_mcp"), serverId: mcpServerIdSchema }).strict(),
  ],
);
