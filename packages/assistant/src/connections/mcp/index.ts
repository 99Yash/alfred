/**
 * The MCP connection door: live client, protocol negotiation, per-connection
 * session cache, connection authorization, and the `mcp_connections` /
 * `mcp_catalog_revisions` row access built on them.
 *
 * This barrel exists so nothing outside this directory reaches a leaf file. It is
 * deliberately NOT re-exported from `connections/index.ts`, for the same reason
 * the `./ingestion` block there is a separate key: importing this subtree
 * evaluates a process-lifetime live-client cache and the credential vault, and a
 * module that only wants a Google connection helper must not pay for that.
 *
 * What is NOT here is the point of the split: the durable invocation ledger, the
 * ADR-0088 approval derivation (`resolveMcpToolIdentity`), and the risk floor live
 * behind `@alfred/assistant/tool-runtime/mcp`. The import direction between the
 * two is one-way — `tool-runtime -> connections` — and the module-graph ratchet
 * refuses the reverse edge by name, so nothing here can consult the approval half.
 *
 * Enforcement tier 1: `./connections` has no `"./connections/*"` wildcard sibling
 * in the package manifest, so the only spellings that resolve into this directory
 * are its two exact `exports` keys — `./connections/mcp` (this file) and
 * `./connections/mcp/test-support`. A name in neither file is unreachable by any
 * package specifier, and WHICH of the two a name sits in is the enforcement.
 * Campaign item 39 exists to keep the wildcard off; item 51 moves the transport
 * leaf (`mcpIntegrationRoutes`) that sits on top of this door out of `@alfred/api`
 * and into `@alfred/http`.
 *
 * That fence only means something if every name below is one a caller SHOULD be
 * able to make, so names a test wants and production does not live behind
 * `./test-support` instead — notably the unguarded catalog-pointer write. Add a
 * name here only after checking a product file calls it.
 */

export {
  McpRawClient,
  type ExternalToolRef,
  type McpCallEnvelope,
  type McpPreparedToolCall,
} from "./client";
export { boundedMcpErrorText, isPreDeliveryErrorCode, McpClientError } from "./errors";
export { canonicalArgsHash, computeDescriptorHashes, descriptorHash } from "./hash";
export { listMcpToolsLocal, type McpListToolsResult, type McpToolSummary } from "./list-tools";
export {
  MCP_OAUTH_PENDING_ISSUER,
  McpConnectionManager,
  type McpConnectionManagerPersistence,
} from "./manager";
export {
  authorizeMcpOAuth,
  finishMcpOAuth,
  mcpOAuthClientConfiguration,
  mcpOAuthProviderForConnection,
  McpOAuthAuthorizationRequiredError,
} from "./oauth";
export {
  insertConnection,
  listOwnedConnections,
  readOwnedConnection,
  updateConnection,
  upsertConnection,
} from "./persistence";
export {
  MCP_CLIENT_CAPABILITIES,
  MCP_INPUT_REQUIRED_PROFILE,
  type McpNegotiatedServer,
  type McpProtocolCallResult,
  type McpProtocolClient,
  type McpProtocolPage,
  type McpProtocolServer,
} from "./protocol";
export { getMcpConnectionManager } from "./runtime";
export { startMcpTraceSpan, type McpTraceContext } from "./trace";
