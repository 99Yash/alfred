/**
 * Built-in MCP providers: endpoint, resource, and client policy pinned in code.
 * Browser-safe copy lives in `BUILT_IN_MCP_CATALOG`; this file holds what Alfred sends.
 * A static client's id and secret come from env on each read, never from a row,
 * so a rotated secret applies on the next token exchange.
 */

import { integrationDisplayName, type BuiltInMCPProvider } from "@alfred/contracts";
import { envFieldValue, type ServerEnv } from "@alfred/env/server";

import { hostedEndpointKey } from "../hosted-endpoint";
import type { McpEndpointOAuthPolicy } from "./endpoint-authorization";
import {
  GITHUB_MCP_ENDPOINT_HREF,
  GITHUB_MCP_ISSUER,
  LINEAR_MCP_ENDPOINT_HREF,
  MCP_OAUTH_PENDING_IDENTITY,
  NOTION_MCP_ENDPOINT_HREF,
  POLYLANE_MCP_ENDPOINT_HREF,
  RAILWAY_MCP_ENDPOINT_HREF,
  SENTRY_MCP_ENDPOINT_HREF,
  VERCEL_MCP_ENDPOINT_HREF,
  VERCEL_MCP_OAUTH_ENDPOINT_ORIGINS,
  VERCEL_MCP_STORED_ISSUER,
} from "./constants";

export type BuiltInOAuthConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
};

/**
 * Only `*_MCP_CLIENT_ID` env keys. Plain `keyof ServerEnv` would let
 * `"OPENAI_API_KEY"` compile and be sent to a third-party server.
 */
type McpClientIdEnvKey = Extract<keyof ServerEnv, `${string}_MCP_CLIENT_ID`>;

type McpClientSecretEnvKey = Extract<keyof ServerEnv, `${string}_MCP_CLIENT_SECRET`>;

/**
 * How to get the OAuth client. `unavailable` is a refusal: never fall through to
 * dynamic registration, which the SDK does when it sees no client.
 * The loopback arm names the provider, not an env key, because no setting fixes it.
 */
export type BuiltInClientResolution =
  | { readonly kind: "dynamic" }
  | { readonly kind: "static"; readonly client: BuiltInOAuthConfig }
  | {
      readonly kind: "unavailable";
      readonly reason: "missing_client_id" | "issuer_not_bound";
      readonly envKey: McpClientIdEnvKey;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "authorization_server_requires_loopback";
      readonly provider: BuiltInProvider;
    };

/** One built-in. Every `URL` derives from `endpointHref`. */
type BuiltInDefinition = {
  readonly instanceKey: string;
  readonly canonicalResource: string;
  readonly endpointHref: string;
  /**
   * A pre-registered client and its issuer. Absent means RFC 7591 dynamic registration.
   * GitHub needs it: no dynamic registration and no URL-based client ids.
   */
  readonly staticClient?: {
    readonly issuer: string;
    readonly clientIdKey: McpClientIdEnvKey;
    readonly clientSecretKey: McpClientSecretEnvKey;
  };
  /**
   * `"loopback-only"`: the server's dynamic registration accepts only
   * `http://localhost` callbacks and answers `400 invalid_redirect_uri` otherwise.
   * Judged per callback, so a local Alfred connects and a hosted one is refused up front.
   */
  readonly clientRegistrationRedirects?: "loopback-only" | undefined;
  /**
   * Baseline scopes for every authorize. Pinned because servers hide tools the
   * token lacks scope for, and the protocol never says so.
   * {@link mcpConsentAsk} unions this with granted and demanded scopes.
   */
  readonly scopes: readonly string[];
  /**
   * The endpoint is a read-only resource (ADR-0094), so every tool must assert
   * `readOnlyHint` or `McpRawClient` refuses the refresh. A hint only ever narrows here.
   */
  readonly readOnlyCatalog: boolean;
  /**
   * Negotiate the legacy `2025-11-25` era (ADR-0095). GitHub declares `x-mcp-header`,
   * which `assertSafeSchema` refuses; the legacy era makes it inert.
   * Stripping the keyword fails: GitHub enforces the header in the modern era.
   */
  readonly pinLegacyProtocol: boolean;
  /** Provider-owned OAuth issuer and endpoint-origin policy, when discovery needs one. */
  readonly oauthPolicy?: McpEndpointOAuthPolicy | undefined;
  readonly initialState: {
    readonly authServerIdentity: string;
    readonly status: "disconnected";
  };
};

/** A built-in row starts unauthorized. */
const BUILT_IN_INITIAL_STATE = {
  authServerIdentity: MCP_OAUTH_PENDING_IDENTITY,
  status: "disconnected",
} as const satisfies BuiltInDefinition["initialState"];

/** One entry per `BUILT_IN_MCP_CATALOG` provider; `satisfies` keeps the two in step. */
export const BUILT_IN_REGISTRY = {
  github: {
    instanceKey: "default",
    canonicalResource: GITHUB_MCP_ENDPOINT_HREF,
    endpointHref: GITHUB_MCP_ENDPOINT_HREF,
    staticClient: {
      issuer: GITHUB_MCP_ISSUER,
      clientIdKey: "GITHUB_MCP_CLIENT_ID",
      clientSecretKey: "GITHUB_MCP_CLIENT_SECRET",
    },
    // `repo` unhides PR and issue tools, `read:org` the team reads. `repo` grants
    // write, so the read-only endpoint is what keeps the token off write tools.
    scopes: ["repo", "read:org"],
    readOnlyCatalog: true,
    pinLegacyProtocol: true,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  linear: {
    instanceKey: "default",
    canonicalResource: LINEAR_MCP_ENDPOINT_HREF,
    endpointHref: LINEAR_MCP_ENDPOINT_HREF,
    // All declared scopes except `openid` and `email`. ADR-0088 keeps every call behind an approval.
    scopes: ["read", "write"],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  notion: {
    instanceKey: "default",
    canonicalResource: NOTION_MCP_ENDPOINT_HREF,
    endpointHref: NOTION_MCP_ENDPOINT_HREF,
    // Notion grants access by the pages the owner shares at consent, not by scope.
    scopes: ["default"],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  sentry: {
    instanceKey: "default",
    canonicalResource: SENTRY_MCP_ENDPOINT_HREF,
    endpointHref: SENTRY_MCP_ENDPOINT_HREF,
    // `org:read` alone hides the issue and event tools.
    scopes: ["org:read", "project:write", "team:write", "event:write"],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  polylane: {
    instanceKey: "default",
    canonicalResource: POLYLANE_MCP_ENDPOINT_HREF,
    endpointHref: POLYLANE_MCP_ENDPOINT_HREF,
    // Empty on purpose: neither metadata document declares `scopes_supported`.
    scopes: [],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  railway: {
    instanceKey: "default",
    canonicalResource: RAILWAY_MCP_ENDPOINT_HREF,
    endpointHref: RAILWAY_MCP_ENDPOINT_HREF,
    // Dynamic registration. The verified pull enforces `RAILWAY_MCP_STORED_ISSUER`.
    // `offline_access` gets the refresh token that keeps the connection `ready`.
    scopes: ["openid", "profile", "email", "offline_access", "workspace:member"],
    // The catalog has writes (`redeploy`). The verified pull reads over GraphQL instead.
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  vercel: {
    instanceKey: "default",
    canonicalResource: VERCEL_MCP_ENDPOINT_HREF,
    endpointHref: VERCEL_MCP_ENDPOINT_HREF,
    // Registration accepts only loopback callbacks, so only a local Alfred can connect.
    // A pinned client would not help: this check runs first. Untested whether
    // Vercel accepts an `https://` callback for its own `client_id`.
    clientRegistrationRedirects: "loopback-only",
    // `offline_access` gets the refresh token that keeps the connection `ready`.
    scopes: ["openid", "offline_access"],
    // The catalog has writes and purchases. The verified pull calls only list tools.
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    oauthPolicy: {
      authorizationServerIssuer: VERCEL_MCP_STORED_ISSUER,
      oauthEndpointOrigins: VERCEL_MCP_OAUTH_ENDPOINT_ORIGINS,
    },
    initialState: BUILT_IN_INITIAL_STATE,
  },
} as const satisfies Record<BuiltInMCPProvider, BuiltInDefinition>;

/** The catalog owns the key space, not `keyof typeof BUILT_IN_REGISTRY`. */
export type BuiltInProvider = BuiltInMCPProvider;

/** The built-in that owns `endpoint`. A query or fragment never matches, so it cannot inherit the pinned client. */
function lookupBuiltIn(endpoint: URL): ResolvedDefinition | undefined {
  if (endpoint.search !== "" || endpoint.hash !== "") return undefined;

  return BY_ENDPOINT.get(hostedEndpointKey(endpoint));
}

/** Same, for a stored href. A corrupt href resolves to `undefined` instead of throwing. */
function lookupBuiltInHref(endpointUrl: string): ResolvedDefinition | undefined {
  try {
    return lookupBuiltIn(new URL(endpointUrl));
  } catch {
    return undefined;
  }
}

/** Pinned scopes for a built-in endpoint, empty for any other. */
export function builtInAuthorizationScopes(endpointUrl: string): readonly string[] {
  return lookupBuiltInHref(endpointUrl)?.scopes ?? [];
}

/**
 * Client config for a stored endpoint; all off for a user-added server.
 * Kept off the barrel. The risk gate uses {@link builtInReadOnlyResource}.
 */
type BuiltInClientPolicy = Pick<
  BuiltInDefinition,
  "readOnlyCatalog" | "pinLegacyProtocol" | "oauthPolicy"
>;

export function builtInClientPolicy(endpointUrl: string): BuiltInClientPolicy {
  const definition = lookupBuiltInHref(endpointUrl);

  return {
    readOnlyCatalog: definition?.readOnlyCatalog ?? false,
    pinLegacyProtocol: definition?.pinLegacyProtocol ?? false,
    oauthPolicy: definition?.oauthPolicy,
  };
}

/** OAuth wire policy for a built-in endpoint, absent for user-added servers. */
export function builtInOAuthPolicyForEndpoint(
  endpointUrl: string,
): McpEndpointOAuthPolicy | undefined {
  return lookupBuiltInHref(endpointUrl)?.oauthPolicy;
}

/** True for a built-in read-only resource (ADR-0096). False when unsure, so the `high` floor holds. */
export function builtInReadOnlyResource(endpointUrl: string): boolean {
  return lookupBuiltInHref(endpointUrl)?.readOnlyCatalog ?? false;
}

/** The built-in provider for a stored endpoint. Derived, never stored (ADR-0093). */
export function builtInProviderForEndpoint(endpointUrl: string): BuiltInProvider | undefined {
  return lookupBuiltInHref(endpointUrl)?.provider;
}

type ResolvedDefinition = BuiltInDefinition & {
  readonly provider: BuiltInProvider;
  /** Origin of {@link BuiltInDefinition.staticClient}'s issuer, absent without one. */
  readonly issuerOrigin?: string;
};

const BY_ENDPOINT: ReadonlyMap<string, ResolvedDefinition> = new Map(
  Object.entries(BUILT_IN_REGISTRY).map(([provider, entry]): [string, ResolvedDefinition] => {
    // Widen so entries without `staticClient` still type the property.
    const definition: BuiltInDefinition = entry;

    return [
      hostedEndpointKey(new URL(definition.endpointHref)),
      {
        ...definition,
        // SAFETY: the registry satisfies `Record<BuiltInMCPProvider, …>`, so its keys are `BuiltInProvider`.
        provider: provider as BuiltInProvider,
        ...(definition.staticClient
          ? { issuerOrigin: new URL(definition.staticClient.issuer).origin }
          : {}),
      },
    ];
  }),
);

/** `redirectUrl` is required: the loopback refusal depends on it. */
export type BuiltInClientRequest = {
  readonly endpoint: URL;
  readonly redirectUrl: URL;
  readonly issuerHint?: string | undefined;
};

/**
 * How to get the OAuth client for `request.endpoint`. On `unavailable`, fail the authorize.
 * A secret without an id is `missing_client_id`.
 * `issuerHint` from discovery must share the pinned issuer's origin.
 */
export function resolveBuiltInClient(request: BuiltInClientRequest): BuiltInClientResolution {
  const definition = lookupBuiltIn(request.endpoint);
  const staticClient = definition?.staticClient;
  const issuerHint = request.issuerHint;

  // Before the pin: no client works for a non-loopback callback on this server.
  if (
    definition?.clientRegistrationRedirects === "loopback-only" &&
    !isLoopbackCallback(request.redirectUrl)
  ) {
    return {
      kind: "unavailable",
      reason: "authorization_server_requires_loopback",
      provider: definition.provider,
    };
  }

  if (!staticClient) return { kind: "dynamic" };
  const envKey = staticClient.clientIdKey;
  const clientId = envFieldValue(envKey);

  if (clientId === undefined) {
    return { kind: "unavailable", reason: "missing_client_id", envKey };
  }

  const issuer = issuerHint ? boundIssuer(definition, issuerHint) : staticClient.issuer;

  if (!issuer) return { kind: "unavailable", reason: "issuer_not_bound", envKey };
  const clientSecret = envFieldValue(staticClient.clientSecretKey);

  return {
    kind: "static",
    client: {
      issuer,
      clientId,
      ...(clientSecret === undefined ? {} : { clientSecret }),
    },
  };
}

/** Owner-facing error for the integrations card. The loopback case must not suggest a setting. */
export function builtInClientUnavailableMessage(
  resolution: Extract<BuiltInClientResolution, { kind: "unavailable" }>,
): string {
  if (resolution.reason === "authorization_server_requires_loopback") {
    return (
      `${integrationDisplayName(resolution.provider)} only accepts OAuth clients that run on this ` +
      "computer, so it cannot be connected to Alfred's server. Use Alfred's Vercel integration " +
      "instead."
    );
  }

  return resolution.reason === "missing_client_id"
    ? `This server needs a pre-registered OAuth client. Set ${resolution.envKey}.`
    : "The authorization server does not match this server's pinned issuer.";
}

function boundIssuer(definition: ResolvedDefinition, issuerHint: string): string | undefined {
  let hint: URL;

  try {
    hint = new URL(issuerHint);
  } catch {
    return undefined;
  }

  return hint.origin === definition.issuerOrigin ? hint.href : undefined;
}

/**
 * `http:` on `localhost`, `127.0.0.0/8`, or `[::1]`, matched exactly.
 * Not `isBlockedHost`: that also covers private ranges these servers refuse.
 * `URL` already canonicalizes IPv4 forms. `https://localhost` and `localhost.` are refused on purpose.
 */
function isLoopbackCallback(url: URL): boolean {
  if (url.protocol !== "http:") return false;

  const host = url.hostname;

  return host === "localhost" || host === "[::1]" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}
