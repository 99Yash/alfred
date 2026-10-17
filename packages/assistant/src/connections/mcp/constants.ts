/** Built-in MCP issuer and endpoint hrefs. */

export const GITHUB_MCP_ISSUER = "https://github.com/" as const;

/**
 * GitHub's read-only MCP path (ADR-0094). The `repo` scope grants writes too;
 * this path withholds them (2026-09-03: `/mcp` 47 tools, `/mcp/readonly` 28, all read-only).
 * This is the canonical resource: changing it needs a data migration, like `0112_retarget_github_mcp_readonly.sql`.
 */
export const GITHUB_MCP_ENDPOINT_HREF = "https://api.githubcopilot.com/mcp/readonly" as const;

/** Linear MCP. Dynamic registration; scopes `read`, `write`, `openid`, `email` (2026-09-12). */
export const LINEAR_MCP_ENDPOINT_HREF = "https://mcp.linear.app/mcp" as const;

/** Notion MCP. Dynamic registration; one scope, `default` (2026-09-12). */
export const NOTION_MCP_ENDPOINT_HREF = "https://mcp.notion.com/mcp" as const;

/** Sentry MCP. Dynamic registration; four scopes (2026-09-12). */
export const SENTRY_MCP_ENDPOINT_HREF = "https://mcp.sentry.dev/mcp" as const;

/**
 * Polylane MCP. Dynamic registration; no `scopes_supported` (2026-09-12).
 * One read-write resource, so ADR-0088 approvals guard its write tools.
 */
export const POLYLANE_MCP_ENDPOINT_HREF = "https://mcp.polylane.com/mcp" as const;

/** Railway MCP. Dynamic registration at `backboard.railway.com` (2026-09-20). */
export const RAILWAY_MCP_ENDPOINT_HREF = "https://mcp.railway.com/mcp" as const;

/**
 * Railway's issuer as stored. Discovery omits the trailing `/`; the stored form has it.
 * The verified pull refuses any other stored issuer.
 */
export const RAILWAY_MCP_STORED_ISSUER = "https://backboard.railway.com/" as const;

/**
 * `auth_server_identity` before the first authorize. Non-null, because
 * `resolveMcpClientAuth` reads non-null as "this connection uses OAuth".
 */
export const MCP_OAUTH_PENDING_IDENTITY = "oauth:pending" as const;
