import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import {
  createGuardedFetch,
  createOriginPinnedFetch,
  createPinnedDispatcher,
  validatePinnedHttpsEndpoint,
  type DnsLookupAll,
  type GuardedFetchRequester,
} from "../hosted-endpoint";
import type { SdkMcpProtocolClientOptions } from "./protocol";

export interface McpEndpointCandidate {
  endpoint: unknown;
  expectedOrigin: unknown;
}

export interface McpAuthorizedEndpoint {
  endpoint: URL;
  oauthResource: URL;
  /** Public-HTTPS guard for OAuth discovery and its persisted authorization server. */
  fetch: SdkMcpProtocolClientOptions["fetch"];
  /** The same socket guard tightened to the MCP resource origin. */
  protocolFetch: SdkMcpProtocolClientOptions["fetch"];
  /** Close the socket boundary before this approval can be replaced. */
  close(): Promise<void>;
}

export interface McpEndpointAuthorizer {
  authorize(candidate: McpEndpointCandidate): Promise<McpAuthorizedEndpoint>;
}

export interface HostedMcpEndpointAuthorizerDependencies {
  lookup?: DnsLookupAll;
  requester?: GuardedFetchRequester;
}

/** Authorize one persisted MCP endpoint and bind all hosted traffic to its guard. */
export class HostedMcpEndpointAuthorizer implements McpEndpointAuthorizer {
  constructor(private readonly dependencies: HostedMcpEndpointAuthorizerDependencies = {}) {}

  async authorize(candidate: McpEndpointCandidate): Promise<McpAuthorizedEndpoint> {
    const endpoint = validatePinnedHttpsEndpoint(candidate.endpoint, candidate.expectedOrigin);
    const dispatcher = createPinnedDispatcher(
      this.dependencies.lookup ? { lookup: this.dependencies.lookup } : {},
    );
    const fetch = createGuardedFetch({
      dispatcher,
      ...(this.dependencies.requester ? { requester: this.dependencies.requester } : {}),
    });
    return Object.freeze({
      endpoint,
      oauthResource: new URL(endpoint.href),
      fetch,
      protocolFetch: createOriginPinnedFetch(fetch, endpoint.origin),
      close: async () => dispatcher.close(),
    });
  }
}

export type McpOAuthProviderFactory = (resource: URL) => OAuthClientProvider;
