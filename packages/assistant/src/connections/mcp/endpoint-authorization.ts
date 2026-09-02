import type { McpConnection } from "@alfred/db/schemas";
import type { FetchLike } from "@modelcontextprotocol/client";
import {
  createGuardedFetch,
  createPinnedDispatcher,
  dispatcherRequester,
  HostedEndpointError,
  isHostedEndpointSensitiveHeader,
  requestFacts,
  validatePinnedHttpsEndpoint,
  validatePublicWebUrl,
  type DnsLookupAll,
  type GuardedFetchRequester,
} from "../hosted-endpoint";

/**
 * The two columns an authorization reads, typed as the row projection so a
 * caller passes the row (or its `Pick`) and cannot swap the URL and the origin.
 */
export type McpEndpointConnection = Pick<McpConnection, "endpointUrl" | "endpointOrigin">;

/**
 * What the owner of a connection is willing to wait for one request. The raw
 * client passes its `requestTimeoutMs` limit so the socket-level policy of the
 * pinned dispatcher cannot undercut the deadline the client declares.
 */
export interface McpEndpointNetworkPolicy {
  requestTimeoutMs: number;
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
  /**
   * Release the socket boundary. Every owner closes its protocol client BEFORE
   * this, so nothing legitimate is in flight when it runs, and it must never
   * wait on a stream the owner has already abandoned.
   */
  close(): Promise<void>;
}

export interface McpEndpointAuthorizer {
  authorize(
    connection: McpEndpointConnection,
    network: McpEndpointNetworkPolicy,
  ): Promise<McpAuthorizedEndpoint>;
}

/** Own one request-scoped authorization from acquisition through release. */
export async function withMcpEndpointAuthorization<T>(
  authorizer: McpEndpointAuthorizer,
  connection: McpEndpointConnection,
  network: McpEndpointNetworkPolicy,
  operation: (authorization: McpAuthorizedEndpoint) => Promise<T>,
): Promise<T> {
  const authorization = await authorizer.authorize(connection, network);
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

function validatePublicHttpsEndpoint(input: unknown): URL {
  const publicUrl = validatePublicWebUrl(input);
  return validatePinnedHttpsEndpoint(publicUrl, publicUrl.origin);
}

/** Bound one OAuth request by the connection's deadline without dropping the caller's own signal. */
function withRequestDeadline(
  init: Parameters<FetchLike>[1],
  requestTimeoutMs: number,
): Parameters<FetchLike>[1] {
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return { ...init, signal };
}

function createAuthorizedOAuth(
  resource: URL,
  guardedFetch: FetchLike,
  network: McpEndpointNetworkPolicy,
): McpAuthorizedOAuth {
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
    const request = requestFacts(input, init);
    const url = validatePublicHttpsEndpoint(request.url);
    const credentialFreeDiscovery =
      (request.method === "GET" || request.method === "HEAD") &&
      request.body == null &&
      [...request.headers.keys()].every((name) => !isHostedEndpointSensitiveHeader(name));
    if (url.origin !== resource.origin && url.origin !== serverOrigin && !credentialFreeDiscovery) {
      throw new HostedEndpointError(
        "origin_mismatch",
        `OAuth request origin ${url.origin} is not authorized.`,
      );
    }
    // The SDK's OAuth flow has no deadline of its own and the shared dispatcher
    // no longer bounds body time (the protocol stream needs it off), so the
    // request budget is applied here, where the request is one-shot.
    return guardedFetch(input, withRequestDeadline(init, network.requestTimeoutMs));
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

  async authorize(
    connection: McpEndpointConnection,
    network: McpEndpointNetworkPolicy,
  ): Promise<McpAuthorizedEndpoint> {
    const endpoint = validatePinnedHttpsEndpoint(connection.endpointUrl, connection.endpointOrigin);
    // Headers and connect are bounded by the connection's own request budget.
    // Body time is deliberately unbounded: the SDK holds a long-lived
    // list-change stream on this dispatcher, and undici's body timeout measures
    // silence between chunks, so any finite value here kills an idle
    // subscription and marks a healthy connection failed.
    const dispatcher = createPinnedDispatcher({
      ...(this.dependencies.lookup ? { lookup: this.dependencies.lookup } : {}),
      timeouts: {
        headersMs: network.requestTimeoutMs,
        connectMs: network.requestTimeoutMs,
        bodyMs: 0,
      },
    });
    const requester = this.dependencies.requester ?? dispatcherRequester(dispatcher);
    let closeFlight: Promise<void> | null = null;
    return Object.freeze({
      oauth: createAuthorizedOAuth(endpoint, createGuardedFetch({ requester }), network),
      protocol: Object.freeze({
        endpoint: new URL(endpoint.href),
        fetch: createGuardedFetch({ requester, expectedOrigin: endpoint.origin }),
      }),
      // `destroy`, not `close`: a graceful close waits for in-flight requests,
      // and with body time unbounded a stuck stream would hold `disconnect()`
      // forever. Owners close the protocol first, so nothing legitimate remains.
      close: () => (closeFlight ??= dispatcher.destroy()),
    });
  }
}
