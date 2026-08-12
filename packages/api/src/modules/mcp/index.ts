/**
 * The MCP transport module. Everything behind it is one Elysia plugin: the
 * connection-management routes and the OAuth callback the MCP authorization flow
 * redirects to.
 *
 * All MCP behavior — live client, session cache, connection rows, the invocation
 * ledger, the risk floor — lives in `@alfred/assistant` behind
 * `./connections/mcp` and `./tool-runtime/mcp`. This module is the transport leaf
 * on top of it, and it is a module of its own rather than a part of
 * `modules/connections` so that `src/index.ts` mounts it from a module index
 * instead of reaching into another module's non-index file. Campaign item 51
 * moves this whole directory into `@alfred/http`.
 */

export { mcpIntegrationRoutes } from "./routes";
