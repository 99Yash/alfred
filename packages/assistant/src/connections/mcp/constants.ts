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
 * Vercel MCP. The root is the endpoint; `/mcp` is 404 (2026-09-23).
 * Registration refuses non-loopback callbacks with `400 invalid_redirect_uri`
 * (2026-09-27), so a hosted Alfred cannot connect. Vercel approves hosted clients by hand.
 * Do not work around it: registration is keyed by IP, so each call overwrites
 * `redirect_uris`, and the limit is 20 per hour per IP.
 */
export const VERCEL_MCP_ENDPOINT_HREF = "https://mcp.vercel.com/" as const;

/**
 * Vercel's issuer as stored, assumed by the Railway trailing-`/` rule. Not verified.
 * If wrong, `openVercelRead` returns `null`; it never admits a foreign issuer.
 */
export const VERCEL_MCP_STORED_ISSUER = "https://vercel.com/" as const;

/** Vercel serves some OAuth endpoints on its API host. The authorization endpoint stays on the issuer origin. */
export const VERCEL_MCP_OAUTH_ENDPOINT_ORIGINS = ["https://api.vercel.com"] as const;

/**
 * `auth_server_identity` before the first authorize. Non-null, because
 * `resolveMcpClientAuth` reads non-null as "this connection uses OAuth".
 */
export const MCP_OAUTH_PENDING_IDENTITY = "oauth:pending" as const;
