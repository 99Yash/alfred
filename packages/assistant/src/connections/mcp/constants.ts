/** Built-in MCP provider constants — single source for issuer and endpoint hrefs. */

export const GITHUB_MCP_ISSUER = "https://github.com/" as const;

/**
 * The READ-ONLY path of GitHub's remote MCP server, not the read-write `/mcp`
 * root (ADR-0094).
 *
 * The two paths are separate protected resources with separate catalogs.
 * Measured with one `repo`-scoped token on 2026-09-03: `/mcp` lists 47 tools,
 * 19 of which report `annotations.readOnlyHint: false` (`merge_pull_request`,
 * `push_files`, `delete_file`, `create_pull_request`, …), while `/mcp/readonly`
 * lists 28, every one of them asserting `readOnlyHint: true`, and still
 * includes every pull request and issue tool Alfred wants. The 28 names are
 * byte-identical to the read subset of the 47. Alfred has to ask for `repo` to
 * see those reads at all (see `BUILT_IN_REGISTRY`), and `repo` is GitHub's only
 * grain for private repository content — so the write catalog comes with the
 * same grant. This path is what withholds it.
 *
 * The path is not the only condition any more. `BuiltInDefinition.readOnlyCatalog`
 * makes `McpRawClient` refuse a catalog in which any descriptor fails to assert
 * `readOnlyHint`, so a write tool served HERE is caught too.
 *
 * Moving this constant moves the CANONICAL RESOURCE, which is the durable
 * identity of the `mcp_servers` row. A stored row is retargeted in place by a
 * data migration (`0112_retarget_github_mcp_readonly.sql`); the registry
 * retarget in `ensureServerDefinition` covers only an endpoint that moves
 * UNDER an unchanged resource.
 */
export const GITHUB_MCP_ENDPOINT_HREF = "https://api.githubcopilot.com/mcp/readonly" as const;

/**
 * Linear's remote MCP server and the authorization server that protects it.
 *
 * Measured on 2026-09-12. An unauthenticated `initialize` answers `401` with
 * `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
 * That document names `https://mcp.linear.app` as the authorization server, and
 * that server publishes a `registration_endpoint`, so Alfred registers its own
 * client (RFC 7591) and needs no pre-registered credential in the environment.
 * `scopes_supported` is `read`, `write`, `openid`, `email`.
 */
export const LINEAR_MCP_ENDPOINT_HREF = "https://mcp.linear.app/mcp" as const;

/**
 * Notion's remote MCP server. Measured on 2026-09-12, same shape as Linear:
 * `401` with resource metadata, an authorization server at
 * `https://mcp.notion.com` that publishes a `registration_endpoint`, and a
 * single supported scope, `default`. The resource names itself
 * `Notion MCP (Beta)`.
 */
export const NOTION_MCP_ENDPOINT_HREF = "https://mcp.notion.com/mcp" as const;

/**
 * Sentry's remote MCP server. Measured on 2026-09-12: `401` with resource
 * metadata, an authorization server at `https://mcp.sentry.dev` with a
 * `registration_endpoint`, and four supported scopes — `org:read`,
 * `project:write`, `team:write`, `event:write`.
 */
export const SENTRY_MCP_ENDPOINT_HREF = "https://mcp.sentry.dev/mcp" as const;

/**
 * Polylane's remote MCP server. Measured on 2026-09-12: `401` with resource
 * metadata, an authorization server at `https://mcp.polylane.com` that
 * publishes a `registration_endpoint`, and NO `scopes_supported` member in
 * either metadata document, so the ask carries no scope at all (see the
 * registry entry). The server card names the resource `Polylane` and declares
 * `transport: streamable-http`.
 *
 * Polylane watches production for the owner — logs, metrics, traces, the
 * infrastructure graph, deployments, and the issues it opens. Alfred connects
 * to it as a READER of that record. The server also serves tools that run a
 * workspace agent tool or map a repository, and ADR-0088 is what keeps each of
 * those behind an approval rather than a catalog pin: the resource is one
 * read-write endpoint, so `readOnlyCatalog` cannot be claimed for it.
 */
export const POLYLANE_MCP_ENDPOINT_HREF = "https://mcp.polylane.com/mcp" as const;

/**
 * Railway's remote MCP server and the authorization server that protects it.
 *
 * Measured on 2026-09-20 against the live discovery document
 * (`GET https://backboard.railway.com/.well-known/oauth-authorization-server`):
 * `issuer` is `https://backboard.railway.com` byte for byte, `registration_endpoint`
 * is `https://backboard.railway.com/oauth/register`, `scopes_supported` is the
 * five scopes the registry asks for, grants include `authorization_code`,
 * `refresh_token` and `device_code`, and `code_challenge_methods_supported` is
 * `["S256"]`. The `registration_endpoint` means Alfred registers its own client
 * (RFC 7591) and needs no pre-registered credential — Railway avoids the
 * static-client problem that blocks GitHub.
 *
 * The live catalog now carries `list-projects`, `list-services`, and
 * `list-deployments`; verified pull reads their structured outputs.
 */
export const RAILWAY_MCP_ENDPOINT_HREF = "https://mcp.railway.com/mcp" as const;

/**
 * Railway's STORED authorization-server identity. Discovery publishes the
 * issuer without a trailing slash, but the OAuth connection stores the URL
 * form with `/`. The live connection was checked on 2026-09-20. Carried as a
 * literal so the verified-pull seam refuses a Railway connection whose stored
 * `authServerIdentity` is anything else.
 */
export const RAILWAY_MCP_STORED_ISSUER = "https://backboard.railway.com/" as const;

/**
 * Vercel's remote MCP server. Measured on 2026-09-23 without credentials: an
 * `initialize` POST to the root answers `401` with
 * `resource_metadata="https://mcp.vercel.com/.well-known/oauth-protected-resource"`,
 * and that document names the resource `https://mcp.vercel.com/` and the
 * authorization server `https://vercel.com`. The `/mcp` path answers `404`, so
 * the root is the endpoint. The authorization server publishes a
 * `registration_endpoint`, so Alfred registers its own client (RFC 7591), and
 * `scopes_supported` is `openid`, `email`, `profile`, `offline_access`.
 *
 * The catalog carries writes (`deploy_to_vercel`) and purchases (`buy_*`), so
 * the resource cannot be pinned read-only. The verified pull calls only
 * `list_teams`, `list_projects`, and `list_deployments`.
 */
export const VERCEL_MCP_ENDPOINT_HREF = "https://mcp.vercel.com/" as const;

/**
 * Vercel's STORED authorization-server identity. Discovery publishes the issuer
 * as `https://vercel.com`, and the OAuth connection stores the URL form with a
 * trailing `/` (the same rule `RAILWAY_MCP_STORED_ISSUER` records). No live
 * Vercel connection existed on 2026-09-23 to confirm the stored bytes, so this
 * is derived from that rule, not measured. A mismatch makes every verified pull
 * read unverified, which leaves the loop live.
 */
export const VERCEL_MCP_STORED_ISSUER = "https://vercel.com/" as const;

/**
 * The `auth_server_identity` a connection row carries before any authorization
 * server is known.
 *
 * The column answers "which authorization server protects this connection".
 * A row that is created by a built-in ensure, or by the generic add door
 * against an endpoint that answered with a challenge, has no answer yet: the
 * issuer arrives from discovery on the first authorize. The sentinel is what
 * makes the column NON-NULL anyway, and `liveClientFactory` reads exactly that
 * non-nullness to decide the connection speaks OAuth at all.
 *
 * It is one constant here rather than a literal at each creation door, because
 * the two doors must agree and the column is the thing both write.
 */
export const MCP_OAUTH_PENDING_IDENTITY = "oauth:pending" as const;
