import { isNonEmptyString, type McpApiKeyPlacement, type Redacted } from "@alfred/contracts";
import type { McpServer } from "@alfred/db/schemas";
import type { FetchLike } from "@modelcontextprotocol/client";
import {
  createGuardedFetch,
  createPinnedDispatcher,
  dispatcherRequester,
  HostedEndpointError,
  isHostedEndpointSensitiveHeader,
  requestFacts,
  validatePinnedHttpsEndpoint,
  type DnsLookupAll,
  type GuardedFetchRequester,
} from "../hosted-endpoint";

/** The server-definition columns an authorization reads. */
export type McpEndpointConnection = Pick<McpServer, "endpointUrl" | "endpointOrigin">;

/** The client's `requestTimeoutMs`, so the dispatcher cannot cut a request off earlier. */
export interface McpEndpointNetworkPolicy {
  requestTimeoutMs: number;
}

/** Provider-owned OAuth endpoint policy injected by the built-in registry. */
export interface McpEndpointOAuthPolicy {
  readonly authorizationServerIssuer: string;
  readonly oauthEndpointOrigins: readonly string[];
}

export interface McpAuthorizedOAuthServer {
  readonly issuer: string;
  readonly origin: string;
  /** Validate issuer and authorization URLs against this server's origin. */
  validateEndpoint(input: unknown): URL;
  /** Validate the token endpoint and remember its exact URL for the fetch guard. */
  validateTokenEndpoint(input: unknown): URL;
  /** Validate the registration endpoint and remember its exact URL for the fetch guard. */
  validateRegistrationEndpoint(input: unknown): URL;
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
  /** Owners close the protocol client first, so this never waits on an abandoned stream. */
  close(): Promise<void>;
}

/** A stored API key for the transport. Not `McpApiKeyAuth`, which carries plaintext once at create. */
export interface McpApiKeyCredentialReader {
  /** Read once per authorization. Not secret. */
  placement(): Promise<McpApiKeyPlacement>;
  /** Opened once per request and never cached. Unwrapped only at the wire. */
  secret(): Promise<Redacted<string>>;
}

export interface McpEndpointAuthorizer {
  authorize(
    connection: McpEndpointConnection,
    network: McpEndpointNetworkPolicy,
    apiKey?: McpApiKeyCredentialReader,
    oauthPolicy?: McpEndpointOAuthPolicy,
  ): Promise<McpAuthorizedEndpoint>;
}

/** Own one request-scoped authorization from acquisition through release. */
export async function withMcpEndpointAuthorization<T>(
  authorizer: McpEndpointAuthorizer,
  connection: McpEndpointConnection,
  network: McpEndpointNetworkPolicy,
  oauthPolicy: McpEndpointOAuthPolicy | undefined,
  operation: (authorization: McpAuthorizedEndpoint) => Promise<T>,
): Promise<T> {
  const authorization = await authorizer.authorize(connection, network, undefined, oauthPolicy);

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

/** Guards for a URL with no stored origin: a new owner endpoint or an OAuth discovery hop. */
export function validatePublicHttpsEndpoint(input: unknown): URL {
  return validatePinnedHttpsEndpoint(input, null);
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
  oauthPolicy?: McpEndpointOAuthPolicy,
): McpAuthorizedOAuth {
  let serverIssuer: string | null = null;
  let serverOrigin: string | null = null;
  const oauthEndpointHrefs = new Set<string>();

  const authorizeServer = (input: unknown): McpAuthorizedOAuthServer => {
    const server = validatePublicHttpsEndpoint(input);

    if (
      oauthPolicy !== undefined &&
      (!isNonEmptyString(oauthPolicy.authorizationServerIssuer) ||
        server.href !== oauthPolicy.authorizationServerIssuer)
    ) {
      throw new HostedEndpointError(
        "origin_mismatch",
        "OAuth authorization server does not match the configured issuer.",
      );
    }

    if (serverIssuer !== null && serverIssuer !== server.href) {
      throw new HostedEndpointError(
        "origin_mismatch",
        `OAuth authorization server changed from ${serverIssuer} to ${server.href}.`,
      );
    }

    serverIssuer = server.href;
    serverOrigin = server.origin;

    const validateOAuthEndpoint = (candidate: unknown): URL => {
      const endpoint = validatePinnedHttpsEndpoint(candidate, null);

      const vercelSiblings =
        oauthPolicy?.oauthEndpointOrigins.some((origin) => origin === endpoint.origin) === true;

      if (endpoint.origin !== server.origin && !vercelSiblings) {
        throw new HostedEndpointError(
          "origin_mismatch",
          "OAuth token and registration endpoints are not authorized for this server.",
        );
      }

      oauthEndpointHrefs.add(endpoint.href);

      return endpoint;
    };

    return Object.freeze({
      issuer: server.href,
      origin: server.origin,
      validateEndpoint: (candidate: unknown) =>
        validatePinnedHttpsEndpoint(candidate, server.origin),
      validateTokenEndpoint: validateOAuthEndpoint,
      validateRegistrationEndpoint: validateOAuthEndpoint,
    });
  };

  const fetch: FetchLike = async (input, init) => {
    const request = requestFacts(input, init);
    const url = validatePublicHttpsEndpoint(request.url);

    const credentialFreeDiscovery =
      (request.method === "GET" || request.method === "HEAD") &&
      request.body == null &&
      [...request.headers.keys()].every((name) => !isHostedEndpointSensitiveHeader(name));

    const oauthEndpoint = oauthEndpointHrefs.has(url.href);

    if (
      url.origin !== resource.origin &&
      url.origin !== serverOrigin &&
      !oauthEndpoint &&
      !credentialFreeDiscovery
    ) {
      throw new HostedEndpointError(
        "origin_mismatch",
        `OAuth request origin ${url.origin} is not authorized.`,
      );
    }

    // The SDK OAuth flow has no deadline and the dispatcher has no body timeout, so bound it here.
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

/**
 * Add the API key to each protocol request. Runs after the guard validates the URL,
 * so the guard sees the owner's URL. The key attaches only on the pinned origin,
 * checked once above both placement arms.
 */
async function withApiKey(
  requester: GuardedFetchRequester,
  apiKey: McpApiKeyCredentialReader,
  origin: string,
): Promise<GuardedFetchRequester> {
  const placement = await apiKey.placement();

  return async (input, init) => {
    const url = new URL(input);

    if (url.origin !== origin) return requester(input, init);

    if (placement.in === "header") {
      const headers = new Headers(init.headers);
      headers.set(placement.name, (await apiKey.secret()).unwrap());

      return requester(input, { ...init, headers });
    }

    url.searchParams.set(placement.name, (await apiKey.secret()).unwrap());

    return requester(url.href, init);
  };
}

/** Authorize one persisted MCP endpoint and bind all hosted traffic to its guard. */
export class HostedMcpEndpointAuthorizer implements McpEndpointAuthorizer {
  constructor(private readonly dependencies: HostedMcpEndpointAuthorizerDependencies = {}) {}

  async authorize(
    connection: McpEndpointConnection,
    network: McpEndpointNetworkPolicy,
    apiKey?: McpApiKeyCredentialReader,
    oauthPolicy?: McpEndpointOAuthPolicy,
  ): Promise<McpAuthorizedEndpoint> {
    const endpoint = validatePinnedHttpsEndpoint(connection.endpointUrl, connection.endpointOrigin);

    // No body timeout: undici measures silence between chunks, which would kill
    // the idle list-change stream.
    const dispatcher = createPinnedDispatcher({
      ...(this.dependencies.lookup ? { lookup: this.dependencies.lookup } : {}),
      timeouts: {
        headersMs: network.requestTimeoutMs,
        connectMs: network.requestTimeoutMs,
        bodyMs: 0,
      },
    });

    const requester = this.dependencies.requester ?? dispatcherRequester(dispatcher);

    // Only protocol requests get the key; OAuth requests use the unwrapped requester.
    const protocolRequester = apiKey
      ? await withApiKey(requester, apiKey, endpoint.origin)
      : requester;

    let closeFlight: Promise<void> | null = null;

    return Object.freeze({
      oauth: createAuthorizedOAuth(
        endpoint,
        createGuardedFetch({ requester }),
        network,
        oauthPolicy,
      ),
      protocol: Object.freeze({
        endpoint: new URL(endpoint.href),
        fetch: createGuardedFetch({
          requester: protocolRequester,
          expectedOrigin: endpoint.origin,
        }),
      }),
      // `destroy`, not `close`: with no body timeout, a stuck stream would block `close` forever.
      close: () => (closeFlight ??= dispatcher.destroy()),
    });
  }
}

let sharedAuthorizer: HostedMcpEndpointAuthorizer | undefined;

/** The process-wide authorizer. Lives here, not in `runtime.ts`, to avoid a cycle with `manager.ts`. */
export function getMcpEndpointAuthorizer(): HostedMcpEndpointAuthorizer {
  return (sharedAuthorizer ??= new HostedMcpEndpointAuthorizer());
}
