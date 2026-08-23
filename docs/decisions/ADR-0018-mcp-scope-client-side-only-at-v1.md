# ADR-0018 — MCP scope: client-side only at v1

**Decision.** Alfred is an **MCP client** at v1: it connects to external MCP servers configured per-user, imports their tool catalogs into its tool registry, and the agent invokes them like any native tool. Alfred-as-MCP-server (exposing alfred's own tools to other agents) is **deferred**.

**Schema sketch.**

```
mcp_servers
  id, user_id, name, url, transport (stdio/http/sse), auth_type, credentials_ref
  capability_cache jsonb        -- last-seen tool schemas
  trust_level      enum(trusted, sandboxed, blocked)
  last_connected_at, status enum(active, error, paused)

mcp_server_tools  -- materialized from capability_cache
  mcp_server_id, tool_name, schema jsonb
  primary key (mcp_server_id, tool_name)
```

**Tool naming.** External tools are namespaced as `mcp:{server_slug}:{tool_name}`. Skill frontmatter `tools` allowlist accepts both native (`gmail:*`) and MCP-sourced (`mcp:clickup-personal:*`) tools.

**Lifecycle.**

- Connect on server startup (and on add); list tools; cache schemas.
- Reconnect with backoff on disconnect.
- Tool calls forward through `metered()` (kind=`tool_api`) for cost attribution.

**Trust + safety.**

- `trust_level`: `trusted` invokes freely; `sandboxed` requires HIL approval per-call; `blocked` disabled.
- Sensitive actions (anything writing to external systems) go through the same staging/approval pipeline as native tools.

**Why MCP client now:**

- Massive tool extensibility without redeploys; community ecosystem at Smithery/mcp.so/registry.
- Same shape as native tools at the registry layer; agent can't tell the difference.
- Per-skill scoping via existing tool allowlist mechanism.
- Implementation is small: `@modelcontextprotocol/sdk` TS client + a tool registry + a metered router.

**Why MCP server deferred:**

- No clear consumer at v1 (would mainly be alfred-from-Claude-Desktop, niche).
- Real attack surface (any connecting agent gets alfred's tools).
- Cleanly addable later as a wrapper over `packages/api` tools.
