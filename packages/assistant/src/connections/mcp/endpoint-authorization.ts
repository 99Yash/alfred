import type { FetchLike } from "@modelcontextprotocol/client";
import {
  createGuardedFetch,
  createOriginPinnedFetch,
  createPinnedDispatcher,
  HostedEndpointError,
  validatePinnedHttpsEndpoint,
  validatePublicWebUrl,
  type DnsLookupAll,
  type GuardedFetchRequester,
} from "../hosted-endpoint";

export interface McpEndpointCandidate {
  endpoint: unknown;
  expectedOrigin: unknown;
}

export interface McpAuthorizedOAuthServer {
  readonly issuer: string;
  readonly origin: string;
  validateEndpoint(input: unknown): URL;
}

/** OAuth authority derived from one live endpoint authorization generation. */
export interface McpAuthorizedOAuth {
  readonly resource: URL;
  readonly fetch: FetchLike;
  /** Select one authorization-server origin and reject any later authority change. */
  authorizeServer(input: unknown): McpAuthorizedOAuthServer;
  /** Validate credential-free discovery URLs before they enter the guarded fetch. */
  validateDiscoveryEndpoint(input: unknown): URL;
  /** Validate resource metadata and URLs against the persisted MCP resource origin. */
  validateResourceEndpoint(input: unknown): URL;
}

/** Protocol authority that cannot be confused with the broader OAuth discovery guard. */
export interface McpAuthorizedProtocol {
  readonly endpoint: URL;
  readonly fetch: FetchLike;
}

export interface McpAuthorizedEndpoint {
  readonly oauth: McpAuthorizedOAuth;
  readonly protocol: McpAuthorizedProtocol;
  /** Close the socket boundary before this approval can be replaced. */
  close(): Promise<void>;
}

export interface McpEndpointAuthorizer {
  authorize(candidate: McpEndpointCandidate): Promise<McpAuthorizedEndpoint>;
}

/** Own one request-scoped authorization from acquisition through release. */
export async function withMcpEndpointAuthorization<T>(
  authorizer: McpEndpointAuthorizer,
  candidate: McpEndpointCandidate,
  operation: (authorization: McpAuthorizedEndpoint) => Promise<T>,
): Promise<T> {
  const authorization = await authorizer.authorize(candidate);
  try {
    return await operation(authorization);
  } finally {
    await authorization.close();
  }
}

export interface HostedMcpEndpointAuthorizerDependencies {
  lookup?: DnsLookupAll;
  requester?: GuardedFetchRequester;
}

const OAUTH_SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "mcp-session-id",
  "traceparent",
  "tracestate",
  "x-api-key",
]);

function validatePublicHttpsEndpoint(input: unknown): URL {
  const publicUrl = validatePublicWebUrl(input);
  return validatePinnedHttpsEndpoint(publicUrl, publicUrl.origin);
}

function oauthRequestFacts(input: Parameters<FetchLike>[0], init: Parameters<FetchLike>[1]) {
  const request = input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(request?.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const body = init?.body ?? request?.body;
  return {
    url: validatePublicHttpsEndpoint(request?.url ?? input),
    credentialFreeDiscovery:
      (method === "GET" || method === "HEAD") &&
      body == null &&
      [...headers.keys()].every((name) => !OAUTH_SENSITIVE_HEADERS.has(name.toLowerCase())),
  };
}

function createAuthorizedOAuth(resource: URL, guardedFetch: FetchLike): McpAuthorizedOAuth {
  let serverIssuer: string | null = null;
  let serverOrigin: string | null = null;
  const authorizeServer = (input: unknown): McpAuthorizedOAuthServer => {
    const server = validatePublicHttpsEndpoint(input);
    if (serverIssuer !== null && serverIssuer !== server.href) {
      throw new HostedEndpointError(
        "origin_mismatch",
        `OAuth authorization server changed from ${serverIssuer} to ${server.href}.`,
      );
    }
    serverIssuer = server.href;
    serverOrigin = server.origin;
    return Object.freeze({
      issuer: server.href,
      origin: server.origin,
      validateEndpoint: (candidate: unknown) =>
        validatePinnedHttpsEndpoint(candidate, server.origin),
    });
  };
  const fetch: FetchLike = async (input, init) => {
    const request = oauthRequestFacts(input, init);
    if (
      request.url.origin !== resource.origin &&
      request.url.origin !== serverOrigin &&
      !request.credentialFreeDiscovery
    ) {
      throw new HostedEndpointError(
        "origin_mismatch",
        `OAuth request origin ${request.url.origin} is not authorized.`,
      );
    }
    return guardedFetch(input, init);
  };
  return Object.freeze({
    resource: new URL(resource.href),
    fetch,
    authorizeServer,
    validateDiscoveryEndpoint: validatePublicHttpsEndpoint,
    validateResourceEndpoint: (input: unknown) =>
      validatePinnedHttpsEndpoint(input, resource.origin),
  });
}

/** Authorize one persisted MCP endpoint and bind all hosted traffic to its guard. */
export class HostedMcpEndpointAuthorizer implements McpEndpointAuthorizer {
  constructor(private readonly dependencies: HostedMcpEndpointAuthorizerDependencies = {}) {}

  async authorize(candidate: McpEndpointCandidate): Promise<McpAuthorizedEndpoint> {
    const endpoint = validatePinnedHttpsEndpoint(candidate.endpoint, candidate.expectedOrigin);
    const dispatcher = createPinnedDispatcher(
      this.dependencies.lookup ? { lookup: this.dependencies.lookup } : {},
    );
    const guardedFetch = createGuardedFetch({
      dispatcher,
      ...(this.dependencies.requester ? { requester: this.dependencies.requester } : {}),
    });
    let closeFlight: Promise<void> | null = null;
    return Object.freeze({
      oauth: createAuthorizedOAuth(endpoint, guardedFetch),
      protocol: Object.freeze({
        endpoint: new URL(endpoint.href),
        fetch: createOriginPinnedFetch(guardedFetch, endpoint.origin),
      }),
      close: () => (closeFlight ??= dispatcher.close()),
    });
  }
}
