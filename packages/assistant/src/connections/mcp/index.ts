/**
 * MCP connections: live client, protocol, session cache, authorization, and row access.
 * Not re-exported from `connections/index.ts`: importing it loads the client cache and
 * the vault (`check:architecture` enforces this). The ledger and approvals live in
 * `tool-runtime/mcp`; imports go only `tool-runtime -> connections`.
 * There is no `./connections/*` export, so this file and `./test-support` are the only doors.
 * Test-only names that grant authority go in `./test-support`.
 */

export {
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  McpRawClient,
  type McpCallEnvelope,
  type McpPreparedToolCall,
} from "./client";

export type { ExternalToolRef } from "@alfred/contracts";

export {
  boundedMcpErrorText,
  isMcpAuthorizationChallenge,
  isMcpTransportFailure,
  isPreDeliveryErrorCode,
  McpClientError,
} from "./errors";

export {
  getMcpEndpointAuthorizer,
  withMcpEndpointAuthorization,
  type McpApiKeyCredentialReader,
  type McpAuthorizedEndpoint,
  type McpAuthorizedOAuth,
  type McpAuthorizedOAuthServer,
  type McpAuthorizedProtocol,
  type McpEndpointAuthorizer,
  type McpEndpointConnection,
  type McpEndpointNetworkPolicy,
} from "./endpoint-authorization";

export { persistApiKeyCredential, readApiKeyAuthForConnection } from "./api-key";

export {
  builtInOAuthPolicyForEndpoint,
  builtInProviderForEndpoint,
  builtInReadOnlyResource,
  type BuiltInProvider,
} from "./built-ins";

export {
  RAILWAY_MCP_ENDPOINT_HREF,
  RAILWAY_MCP_STORED_ISSUER,
  VERCEL_MCP_ENDPOINT_HREF,
  VERCEL_MCP_STORED_ISSUER,
} from "./constants";

export { mcpConsentAsk, type McpConsentAsk, type McpConsentConnection } from "./consent";

// `projectCatalogRevision` stays private to publication.
export { canonicalArgsHash, descriptorHash } from "./hash";

export { inspectMcpToolLocal, listMcpToolsLocal, searchMcpToolsLocal } from "./list-tools";

export { McpConnectionManager, type McpConnectionManagerPersistence } from "./manager";

export { parseMcpToolResult } from "./result";

export {
  mcpOAuthClientConfiguration,
  mcpOAuthProviderForConnection,
  McpOAuthAuthorizationRequiredError,
  type McpBoundOAuthSession,
  type McpOAuthProviderForConnectionInput,
  type McpOAuthSessionFactory,
} from "./oauth";

export {
  ensureBuiltInConnection,
  listOwnedConnections,
  readOwnedConnection,
  updateConnection,
  type McpConnectionRemovalGate,
  type McpConnectionSummary,
} from "./persistence";

export { addUserMcpServer, isAddUserMcpServerRefusal } from "./provision";

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

export { startMcpConnectionRecovery, stopMcpConnectionRecovery } from "./connection-recovery";

export { startMcpTraceSpan, type McpTraceContext } from "./trace";
