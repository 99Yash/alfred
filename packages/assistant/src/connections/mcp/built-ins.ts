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
 * reads inside `resolve()`). The read goes through `envFieldValue()` — a
 * per-field `serverEnvSchema` parse that validates via `optionalSecret` on
 * every call and does not cache the whole environment — plus it is
 * parameterized by the registry entry's `env` keys so a second provider does
 * not copy hard-coded `GITHUB_MCP_*` names.
 */

import { envFieldValue } from "@alfred/env/server";

import { GITHUB_MCP_ENDPOINT_HREF, GITHUB_MCP_ISSUER } from "./constants";

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
 *
 * `endpointHref` is the single wire/storage truth; a `URL` is derived at the
 * use site via `new URL(...)` so the two cannot drift. `env` parameterizes
 * which environment variables own this entry's credentials.
 */
export const BUILT_IN_REGISTRY = {
  github: {
    // Migration 0108 gives every historic server its one server-scoped built-in slot.
    instanceKey: "default",
    label: "GitHub MCP",
    canonicalResource: GITHUB_MCP_ENDPOINT_HREF,
    endpointHref: GITHUB_MCP_ENDPOINT_HREF,
    issuer: GITHUB_MCP_ISSUER,
    env: {
      clientIdKey: "GITHUB_MCP_CLIENT_ID" as const,
      clientSecretKey: "GITHUB_MCP_CLIENT_SECRET" as const,
    },
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

function readEnvForEntry(
  entry: (typeof BUILT_IN_REGISTRY)[BuiltInProvider],
): { clientId: string | undefined; clientSecret: string | undefined } {
  const clientId = envFieldValue(entry.env.clientIdKey) as string | undefined;
  const clientSecret = envFieldValue(entry.env.clientSecretKey) as string | undefined;
  return { clientId, clientSecret };
}

function findBuiltInEntryByEndpoint(
  endpoint: URL,
): [BuiltInProvider, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]] | undefined {
  // Query and fragment are not part of the canonical built-in resource.
  // Treat `https://api.githubcopilot.com/mcp?foo=1` or `#frag` as NOT built-in
  // so an attacker-supplied URL cannot inherit the pre-registered client.
  // This uses the URL substrate (origin + pathname) instead of the hand-rolled
  // `endsWith("/")` string check that the review flagged.
  if (endpoint.search !== "" || endpoint.hash !== "") return undefined;
  let endpointOrigin: string;
  let endpointPath: string;
  try {
    endpointOrigin = endpoint.origin;
    endpointPath = endpoint.pathname.replace(/\/+$/, "");
    if (endpointPath === "") endpointPath = "/";
  } catch {
    return undefined;
  }
  for (const entry of Object.entries(BUILT_IN_REGISTRY) as Array<
    [BuiltInProvider, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]]
  >) {
    const defUrl = new URL(entry[1].endpointHref);
    const defPath = defUrl.pathname.replace(/\/+$/, "");
    const normalizedDefPath = defPath === "" ? "/" : defPath;
    const normalizedEndpointPath = endpointPath === "" ? "/" : endpointPath;
    if (endpointOrigin === defUrl.origin && normalizedEndpointPath === normalizedDefPath) {
      return entry;
    }
  }
  return undefined;
}

function findBuiltInEntryByProvider(
  provider: string,
): [BuiltInProvider, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]] | undefined {
  const entry = (BUILT_IN_REGISTRY as Record<string, (typeof BUILT_IN_REGISTRY)[BuiltInProvider]>)[
    provider
  ];
  return entry ? [provider as BuiltInProvider, entry] : undefined;
}

export function isBuiltInEndpoint(endpoint: URL): boolean {
  return !!findBuiltInEntryByEndpoint(endpoint);
}

/**
 * Single joint for “static client for this built-in, optionally bound to
 * issuerHint”. Collapses the previous four doors
 * (`getBuiltInStaticOAuthConfig`, `...ForEndpoint`, `...WithIssuerHint`,
 * `getBuiltInClientSecretForEndpoint`) into one — a second built-in touches
 * one registry entry and no call site needs to choose which of four names to
 * call.
 *
 * Presence is decided by `clientId`; a `clientSecret` alone (secret-only env)
 * does not make the built-in present, so the secret-only `token_endpoint_auth_method`
 * patch and the `clientInformation` fallback agree.
 */
export function resolveBuiltInClient(
  input: { endpoint: URL; issuerHint?: string | undefined } | { provider: BuiltInProvider },
): BuiltInOAuthConfig | undefined {
  const found =
    "endpoint" in input
      ? findBuiltInEntryByEndpoint(input.endpoint)
      : findBuiltInEntryByProvider(input.provider);
  if (!found) return undefined;
  const [, def] = found;
  const { clientId, clientSecret } = readEnvForEntry(def);
  if (!clientId) return undefined;
  if ("endpoint" in input && input.issuerHint) {
    try {
      const hintHref = new URL(input.issuerHint).href;
      const hintOrigin = new URL(hintHref).origin;
      const expectedOrigin = new URL(def.issuer).origin;
      if (hintOrigin !== expectedOrigin) return undefined;
      return {
        issuer: hintHref,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      };
    } catch {
      return undefined;
    }
  }
  return {
    issuer: def.issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  };
}
