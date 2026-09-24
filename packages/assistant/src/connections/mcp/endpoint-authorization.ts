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

/**
 * The two columns an authorization reads, typed as the server-definition row
 * projection so a caller passes `connection.server` (or its `Pick`) and cannot
 * swap the URL and the origin. The endpoint is a fact of the server definition,
 * not of the connection instance.
 */
export type McpEndpointConnection = Pick<McpServer, "endpointUrl" | "endpointOrigin">;

/**
 * What the owner of a connection is willing to wait for one request. The raw
 * client passes its `requestTimeoutMs` limit so the socket-level policy of the
 * pinned dispatcher cannot undercut the deadline the client declares.
 */
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
  /**
   * Release the socket boundary. Every owner closes its protocol client BEFORE
   * this, so nothing legitimate is in flight when it runs, and it must never
   * wait on a stream the owner has already abandoned.
   */
  close(): Promise<void>;
}

/**
 * An owner-supplied API key as the transport reads it: the placement is read
 * once when the authorization is built, and the secret is opened once per
 * request and never cached by Alfred.
 *
 * Named "reader" to stay distinct from the contract's wire credential
 * `McpApiKeyAuth` (`@alfred/contracts`), which carries the plaintext value
 * exactly once at the create door. This is the per-request transport seam a
 * persisted connection gets instead: it opens the sealed row on demand.
 */
export interface McpApiKeyCredentialReader {
  /** Placement, read once when the endpoint authorization is built. Not secret. */
  placement(): Promise<McpApiKeyPlacement>;
  /**
   * The opened secret, carried as a {@link Redacted} so the default string paths
   * (interpolation, `JSON.stringify`, a log) cannot expose it; read once per
   * HTTP request, never cached by Alfred. The only `.unwrap()` is at the wire,
   * where the placement is set.
   */
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

/**
 * The guard stack for a URL with no stored origin behind it: a brand-new
 * endpoint the owner supplied (#1004), or an OAuth discovery hop.
 *
 * Exported because the generic add door applies exactly this stack before it
 * writes a row, and a second copy there is a second thing to keep in step with
 * the pinned rules every later connect enforces.
 */
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

/**
 * Wrap one requester so an owner-supplied API key rides every protocol request
 * in its configured placement.
 *
 * The placement is resolved once, here, when the authorization is built; only
 * the secret is read per request. The wrapper runs where `createGuardedFetch`
 * calls its requester — that is, AFTER the per-hop `validate(...)` on the
 * request URL — so the URL the guard checks is the owner's URL and never
 * Alfred's injected parameter. The two arms place the secret differently and
 * neither mutates the guard's own `Headers`: the header arm clones them, and the
 * query arm rewrites only the URL.
 *
 * BOTH arms attach only when the request already targets the pinned origin.
 * `createGuardedFetch` pins protocol traffic to that origin, so an off-origin hop
 * is refused before this runs; the shared check keeps the key off any future
 * caller that wires this wrapper without that pin. It is one test ABOVE the arm
 * split, so a later arm inherits it rather than having to remember it — the same
 * check on the query arm alone left the header arm attaching unconditionally.
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

    // Only the PROTOCOL requester is wrapped. OAuth discovery below builds its
    // own guarded fetch from the unwrapped requester, so the key can never ride
    // a discovery or token request to the authorization server.
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
      // `destroy`, not `close`: a graceful close waits for in-flight requests,
      // and with body time unbounded a stuck stream would hold `disconnect()`
      // forever. Owners close the protocol first, so nothing legitimate remains.
      close: () => (closeFlight ??= dispatcher.destroy()),
    });
  }
}

let sharedAuthorizer: HostedMcpEndpointAuthorizer | undefined;

/**
 * The one endpoint authorizer for the process.
 *
 * It carries no per-connection state, but it does build an undici dispatcher
 * and a pinned DNS lookup on every `authorize` call, and every MCP door needs
 * one: the live client factory, the OAuth start/callback routes, and the
 * generic add probe. One lazy instance instead of one `new` per module.
 *
 * It sits here rather than in `runtime.ts` because `runtime.ts` imports
 * `manager.ts`, and `manager.ts` is one of the callers.
 */
export function getMcpEndpointAuthorizer(): HostedMcpEndpointAuthorizer {
  return (sharedAuthorizer ??= new HostedMcpEndpointAuthorizer());
}
