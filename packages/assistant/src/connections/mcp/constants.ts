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
