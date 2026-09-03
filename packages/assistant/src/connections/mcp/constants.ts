/** Built-in MCP provider constants — single source for issuer and endpoint hrefs. */

export const GITHUB_MCP_ISSUER = "https://github.com/" as const;

/**
 * The READ-ONLY path of GitHub's remote MCP server, not the read-write `/mcp`
 * root.
 *
 * The two paths are separate protected resources with separate catalogs, and
 * the catalog each one returns is filtered by the token's scopes. Measured with
 * one `repo`-scoped token: `/mcp` lists 47 tools, 16 of which write (
 * `merge_pull_request`, `push_files`, `delete_file`, `create_pull_request`, …),
 * while `/mcp/readonly` lists 28, all reads, and still includes every pull
 * request and issue tool Alfred wants. `repo` is GitHub's only grain for
 * private repository content, so asking for it is what unhides those reads —
 * this path is what keeps the same grant from also handing the boss a write
 * catalog. ADR-0052 keeps Alfred's GitHub surface read-only, and this is that
 * rule expressed as the resource rather than as a per-tool policy.
 *
 * Moving this constant moves the CANONICAL RESOURCE, which is the durable
 * identity of the `mcp_servers` row. A stored row is retargeted in place by a
 * data migration (`0112_retarget_github_mcp_readonly.sql`); the registry
 * retarget in `ensureServerDefinition` covers only an endpoint that moves
 * UNDER an unchanged resource.
 */
export const GITHUB_MCP_ENDPOINT_HREF = "https://api.githubcopilot.com/mcp/readonly" as const;
