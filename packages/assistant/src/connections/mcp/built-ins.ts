/**
 * Built-in MCP provider registry — single source of truth for closed provider
 * definitions (PRD #540 / #934).
 *
 * Both `persistence.ts` (`builtInStaticOAuthClient*`, `ensureBuiltInConnection`)
 * and `oauth.ts` (`#staticBuiltInClient`, constructor secret patch) read this
 * table. Adding a second built-in or opening `POST /connections
 * {canonicalResource, endpointUrl}` touches one site.
 *
 * Environment reads stay lazy inside the factories so per-test `process.env`
 * overrides still work (same reason `packages/integrations/src/integrations.ts`
 * reads inside `resolve()`).
 */

import { GITHUB_MCP_ENDPOINT_HREF, GITHUB_MCP_ISSUER } from "./constants";

export { GITHUB_MCP_ENDPOINT_HREF, GITHUB_MCP_ISSUER } from "./constants";

export type BuiltInOAuthConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
};

/**
 * One built-in definition. Keep shape compatible with `BUILT_IN_CONNECTIONS`
 * previously private to `persistence.ts` so `ensureBuiltInConnection` can spread
 * it into a `CreateNamedMcpConnectionInput` without adaptation. `oauth` is kept
 * as the single place that declares the provider needs a human-registered client
 * (`client_information` seeded for its issuer, SDK skips DCR).
 */
export const BUILT_IN_REGISTRY = {
  github: {
    // Migration 0108 gives every historic server its one server-scoped built-in slot.
    instanceKey: "default",
    label: "GitHub MCP",
    canonicalResource: GITHUB_MCP_ENDPOINT_HREF,
    endpoint: new URL(GITHUB_MCP_ENDPOINT_HREF),
    endpointHref: GITHUB_MCP_ENDPOINT_HREF,
    issuer: GITHUB_MCP_ISSUER,
    initialState: {
      authServerIdentity: "oauth:pending",
      status: "disconnected" as const,
    },
    oauth: {
      issuer: GITHUB_MCP_ISSUER,
    },
  },
} as const;

export type BuiltInProvider = keyof typeof BUILT_IN_REGISTRY;

function canonicalIssuer(value: string): string {
  return new URL(value).href;
}

function normalizeEndpointHref(href: string): string {
  // Collapse the trailing-slash duplicate:
  // "https://api.githubcopilot.com/mcp/" -> "https://api.githubcopilot.com/mcp"
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

function readBuiltInEnv(): { clientId: string | undefined; clientSecret: string | undefined } {
  const rawId = process.env.GITHUB_MCP_CLIENT_ID; // drift-ok - reads optional GitHub MCP id without full env validation
  const clientId = typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : undefined;
  const rawSecret = process.env.GITHUB_MCP_CLIENT_SECRET; // drift-ok - same fallback for secret
  const clientSecret =
    typeof rawSecret === "string" && rawSecret.trim() !== "" ? rawSecret.trim() : undefined;
  return { clientId, clientSecret };
}

export function isBuiltInEndpoint(endpoint: URL): boolean {
  const normalized = normalizeEndpointHref(endpoint.href);
  return (Object.values(BUILT_IN_REGISTRY) as ReadonlyArray<(typeof BUILT_IN_REGISTRY)[BuiltInProvider]>).some(
    (def) => normalized === def.endpointHref,
  );
}

function findBuiltInEntryForEndpoint(
  endpoint: URL,
): [BuiltInProvider, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]] | undefined {
  const normalized = normalizeEndpointHref(endpoint.href);
  for (const entry of Object.entries(BUILT_IN_REGISTRY) as Array<
    [BuiltInProvider, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]]
  >) {
    if (normalized === entry[1].endpointHref) return entry;
  }
  return undefined;
}

function findBuiltInEntryForProvider(
  provider: string,
): [BuiltInProvider, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]] | undefined {
  const entry = (BUILT_IN_REGISTRY as Record<string, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]>)[provider];
  return entry ? [provider as BuiltInProvider, entry] : undefined;
}

/** Lazy env read inside factory — see module header. */
export function getBuiltInStaticOAuthConfig(provider: BuiltInProvider): BuiltInOAuthConfig | undefined {
  const found = findBuiltInEntryForProvider(provider);
  if (!found) return undefined;
  const [, def] = found;
  const { clientId, clientSecret } = readBuiltInEnv();
  if (!clientId) return undefined;
  return {
    issuer: def.issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  };
}

/** Endpoint-aware variant: collapses trailing-slash duplicate in one place. */
export function getBuiltInStaticOAuthConfigForEndpoint(endpoint: URL): BuiltInOAuthConfig | undefined {
  const found = findBuiltInEntryForEndpoint(endpoint);
  if (!found) return undefined;
  const [provider] = found;
  return getBuiltInStaticOAuthConfig(provider);
}

/**
 * Issuer-hint-aware variant for `McpOAuthProvider#staticBuiltInClient`.
 * Validates the hint's origin against the built-in's issuer origin, mirroring
 * the previous per-site check in `oauth.ts:700`, and canonicalizes the issuer
 * to `new URL(hint).href` when a hint is supplied.
 */
export function getBuiltInStaticOAuthConfigWithIssuerHint(
  endpoint: URL,
  issuerHint?: string,
): BuiltInOAuthConfig | undefined {
  const found = findBuiltInEntryForEndpoint(endpoint);
  if (!found) return undefined;
  const [, def] = found;
  const { clientId, clientSecret } = readBuiltInEnv();
  if (!clientId) return undefined;
  if (issuerHint) {
    try {
      const hintOrigin = new URL(canonicalIssuer(issuerHint)).origin;
      const expectedOrigin = new URL(def.issuer).origin;
      if (hintOrigin !== expectedOrigin) return undefined;
    } catch {
      return undefined;
    }
    const issuer = canonicalIssuer(issuerHint);
    return {
      issuer,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    };
  }
  return {
    issuer: def.issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  };
}

/** Whether the endpoint belongs to a built-in that currently carries a client_secret. */
export function getBuiltInClientSecretForEndpoint(endpoint: URL): string | undefined {
  const found = findBuiltInEntryForEndpoint(endpoint);
  if (!found) return undefined;
  const { clientSecret } = readBuiltInEnv();
  return clientSecret;
}
