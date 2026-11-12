/**
 * Built-in MCP providers: endpoint, resource, and client policy pinned in code.
 * Browser-safe copy lives in `BUILT_IN_MCP_CATALOG`; this file holds what Alfred sends.
 * A static client's id and secret come from env on each read, never from a row,
 * so a rotated secret applies on the next token exchange.
 */

import { integrationDisplayName, typedEntries, type BuiltInMCPProvider } from "@alfred/contracts";
import { envFieldValue } from "@alfred/env/server";

import { hostedEndpointKey } from "../hosted-endpoint";
import {
  CLICKUP_MCP_ENDPOINT_HREF,
  GITHUB_MCP_ENDPOINT_HREF,
  GITHUB_MCP_ISSUER,
  LINEAR_MCP_ENDPOINT_HREF,
  MCP_OAUTH_PENDING_IDENTITY,
  NOTION_MCP_ENDPOINT_HREF,
  POLYLANE_MCP_ENDPOINT_HREF,
  RAILWAY_MCP_ENDPOINT_HREF,
  SENTRY_MCP_ENDPOINT_HREF,
} from "./constants";

export type BuiltInOAuthConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
};

/**
 * How to get the OAuth client. `unavailable` is a refusal: never fall through to
 * dynamic registration, which the SDK does when it sees no client.
 * No arm names a missing client id: the one pinned client is the GitHub App's, and the
 * boot parse requires its id (`min(1)`).
 */
export type BuiltInClientResolution =
  | { readonly kind: "dynamic" }
  | { readonly kind: "static"; readonly client: BuiltInOAuthConfig }
  | { readonly kind: "unavailable"; readonly reason: "issuer_not_bound" }
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
   * GitHub needs it: no dynamic registration and no URL-based client ids. Its MCP uses the
   * GitHub App's client (ADR-0093 amendment 2026-11-12). The env keys are literals, not
   * `keyof ServerEnv`, which would let `"CLOUDFLARE_AI_GATEWAY_TOKEN"` go to a third party.
   */
  readonly staticClient?: {
    readonly issuer: string;
    readonly clientIdKey: "GITHUB_APP_CLIENT_ID";
    readonly clientSecretKey: "GITHUB_APP_CLIENT_SECRET";
  };
  /**
   * `"loopback-only"`: the server's dynamic registration accepts only
   * `http://localhost` callbacks and answers `400 invalid_redirect_uri` otherwise.
   * Judged per callback, so a local Alfred connects and a hosted one is refused up front.
   * No entry sets it today. Vercel did, and left the registry for its curated grant
   * (`docs/plans/vercel-mcp-retirement.md`); the seam stays for the next such server.
   */
  readonly clientRegistrationRedirects?: "loopback-only" | undefined;
  /**
   * Baseline scopes for every authorize. Pinned because servers hide tools the
   * token lacks scope for, and the protocol never says so.
   * {@link mcpConsentAsk} adds the granted and demanded scopes only on a step-up.
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
    // The GitHub App's client (ADR-0093 amendment 2026-11-12). The install callback gives
    // its user token to this connection (`adoptGithubAppGrant`), so one screen connects both.
    staticClient: {
      issuer: GITHUB_MCP_ISSUER,
      clientIdKey: "GITHUB_APP_CLIENT_ID",
      clientSecretKey: "GITHUB_APP_CLIENT_SECRET",
    },
    // Empty on purpose: an App user token has no scopes (`scope: ""`). The App's permissions and
    // its installed repos limit it. With such a token the endpoint lists all 28 tools (2026-11-12).
    // A non-empty pin would never be in the grant, and `mcpConsentAsk` would ask again each time.
    scopes: [],
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
  clickup: {
    instanceKey: "default",
    canonicalResource: CLICKUP_MCP_ENDPOINT_HREF,
    endpointHref: CLICKUP_MCP_ENDPOINT_HREF,
    // Both declared scopes. ADR-0088 keeps every call behind an approval.
    scopes: ["read", "write"],
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
type BuiltInClientPolicy = Pick<BuiltInDefinition, "readOnlyCatalog" | "pinLegacyProtocol">;

export function builtInClientPolicy(endpointUrl: string): BuiltInClientPolicy {
  const definition = lookupBuiltInHref(endpointUrl);

  return {
    readOnlyCatalog: definition?.readOnlyCatalog ?? false,
    pinLegacyProtocol: definition?.pinLegacyProtocol ?? false,
  };
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
  typedEntries(BUILT_IN_REGISTRY).map(([provider, entry]): [string, ResolvedDefinition] => {
    // Widen so entries without `staticClient` still type the property.
    const definition: BuiltInDefinition = entry;

    return [
      hostedEndpointKey(new URL(definition.endpointHref)),
      {
        ...definition,
        provider,
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
  const issuer = issuerHint ? boundIssuer(definition, issuerHint) : staticClient.issuer;

  if (!issuer) return { kind: "unavailable", reason: "issuer_not_bound" };
  // Read on each call, so a rotated value applies on the next exchange. The boot parse
  // requires the id, so only a process that clears it after boot gets here: a bug, not a state.
  const clientId = envFieldValue(staticClient.clientIdKey);

  if (clientId === undefined) throw new Error(`${staticClient.clientIdKey} is unset.`);
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
      "computer, so it cannot be connected to Alfred's server."
    );
  }

  return "The authorization server does not match this server's pinned issuer.";
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
