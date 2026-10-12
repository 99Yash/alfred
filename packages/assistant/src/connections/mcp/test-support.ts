/**
 * Test-only MCP controls, kept off the product barrel because each grants authority:
 * `ensureConnection` skips the endpoint probe, `publishCatalogRevision` moves the
 * catalog pointer without compare-and-set, and `_setMcpConnectionManagerForTests`
 * does not reset the broker built on the old manager.
 */

export { ensureConnection, publishCatalogRevision } from "./persistence";

export { _setMcpConnectionManagerForTests } from "./runtime";

import type { McpAuthorizedOAuth, McpEndpointAuthorizer } from "./endpoint-authorization";

export function permissiveMcpOAuthAuthorizationForTests(
  resource: URL,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): McpAuthorizedOAuth {
  return {
    resource: new URL(resource.href),
    fetch,
    authorizeServer: (input) => {
      const server = new URL(input);

      return {
        issuer: server.href,
        origin: server.origin,
        validateEndpoint: (candidate) => new URL(candidate),
        validateTokenEndpoint: (candidate) => new URL(candidate),
        validateRegistrationEndpoint: (candidate) => new URL(candidate),
      };
    },
    validateDiscoveryEndpoint: (input) => new URL(input),
    validateResourceEndpoint: (input) => new URL(input),
  };
}

/** Skip hosted-network policy for loopback or fake transports. */
export function permissiveMcpEndpointAuthorizerForTests(
  fetch: typeof globalThis.fetch = globalThis.fetch,
): McpEndpointAuthorizer {
  return {
    authorize: async ({ endpointUrl }) => {
      const authorizedEndpoint = new URL(endpointUrl);

      return {
        oauth: permissiveMcpOAuthAuthorizationForTests(authorizedEndpoint, fetch),
        protocol: { endpoint: authorizedEndpoint, fetch },
        close: async () => undefined,
      };
    },
  };
}
