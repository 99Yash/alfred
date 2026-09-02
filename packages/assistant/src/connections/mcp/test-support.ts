/**
 * Catalog and session-cache controls for tests only, kept off the product door
 * (`@alfred/assistant/connections/mcp`) so that door publishes what production
 * calls and nothing else. `packages/assistant/src/action-policies/test-support.ts`
 * is the precedent and the reason: reaching either name means writing a subpath
 * called `test-support`, which no product file has a reason to write.
 *
 * The door is tier 1 — an exact `exports` key with no wildcard sibling, so the
 * only names reachable by a package specifier are the ones the door and this file
 * export between them. That fence only points the right way if the names on the
 * DOOR are the ones a caller should be able to make. Both names below fail that
 * test, which is why they are here and not there:
 *
 *  - `publishCatalogRevision` advances a connection's catalog pointer
 *    UNCONDITIONALLY. Production never does that; `McpConnectionManager` advances
 *    the pointer through `compareAndSetCatalogRevision` at six call sites, which
 *    refuses a stale expected revision. Publishing the unguarded write while the
 *    guarded pair stays private would have the fence authorize exactly the call
 *    the module exists to prevent.
 *  - `_setMcpConnectionManagerForTests` replaces the process-lifetime session
 *    cache. Replacing it does NOT invalidate the execution broker that was built
 *    over it (they are separate singletons since the module split), so a product
 *    caller would get two views of one connection.
 *
 * Cross-package tests are the only reason either name leaves the directory at all
 * — `packages/assistant`'s own tests reach the leaf files relatively.
 */

export { publishCatalogRevision } from "./persistence";
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
      const server = new URL(input instanceof URL ? input.href : String(input));
      return {
        issuer: server.href,
        origin: server.origin,
        validateEndpoint: (candidate) =>
          new URL(candidate instanceof URL ? candidate.href : String(candidate)),
      };
    },
    validateDiscoveryEndpoint: (input) =>
      new URL(input instanceof URL ? input.href : String(input)),
    validateResourceEndpoint: (input) => new URL(input instanceof URL ? input.href : String(input)),
  };
}

/** Explicitly bypass hosted-network policy for hermetic loopback/fake transports. */
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
