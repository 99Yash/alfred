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
