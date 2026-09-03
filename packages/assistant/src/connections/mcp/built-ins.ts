/**
 * Built-in MCP provider registry — the single source of truth for closed
 * provider definitions (PRD #540 / #934).
 *
 * A built-in is a provider whose endpoint, canonical resource, issuer and OAuth
 * client Alfred pins in CODE. `oauth.ts` reads the client through
 * `resolveBuiltInClient`, and `persistence.ts` turns one entry into the input of
 * a connection ensure. A second built-in adds one entry here and edits nothing
 * else.
 *
 * The environment is canonical for a built-in client, and nothing writes the
 * client id or the client secret to a durable row. An operator who rotates
 * `GITHUB_MCP_CLIENT_SECRET` therefore gets the new value on the next token
 * exchange. Reads stay lazy inside `resolveBuiltInClient` so a per-test
 * `process.env` override still works — the same reason
 * `packages/integrations/src/integrations.ts` reads inside `resolve()`.
 * `envFieldValue()` parses one `serverEnvSchema` field per call and caches
 * nothing, and the `env` keys are part of the entry, so a second provider does
 * not copy hard-coded `GITHUB_MCP_*` names.
 */

import { envFieldValue, type ServerEnv } from "@alfred/env/server";

import { GITHUB_MCP_ENDPOINT_HREF, GITHUB_MCP_ISSUER } from "./constants";

export type BuiltInOAuthConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
};

/**
 * One built-in definition.
 *
 * `endpointHref` is the one wire and storage truth; every `URL` is derived from
 * it, so the two cannot drift. `instanceKey` is the stable slot the provider
 * owns inside its server definition — migration 0108 gives every historic row
 * the same `default` key.
 */
type BuiltInDefinition = {
  readonly instanceKey: string;
  readonly label: string;
  readonly canonicalResource: string;
  readonly endpointHref: string;
  readonly issuer: string;
  readonly env: {
    readonly clientIdKey: keyof ServerEnv;
    readonly clientSecretKey: keyof ServerEnv;
  };
  /**
   * OAuth scopes Alfred asks for on EVERY authorize for this provider, and the
   * one home for WHY a built-in needs a pinned ask at all.
   *
   * The remote MCP server decides what its `tools/list` contains from the
   * token it is given, and GitHub's server HIDES a tool whose scope the token
   * lacks instead of failing the call. A `gho_` token with an empty scope
   * therefore produced a catalog of 8 tools with no pull request or issue tool
   * in it. Nothing in the protocol reports that shortfall, so the ask cannot
   * be discovered at run time: it is pinned here, beside the endpoint the
   * scopes belong to.
   *
   * This is the BASELINE, not the whole ask. {@link mcpConsentAsk} unions it
   * with the connection's granted scopes and with any scope the server later
   * demanded through an insufficient-scope response, so a runtime demand still
   * widens the next consent.
   */
  readonly scopes: readonly string[];
  readonly initialState: {
    readonly authServerIdentity: string;
    readonly status: "disconnected";
  };
};

export const BUILT_IN_REGISTRY = {
  github: {
    instanceKey: "default",
    label: "GitHub MCP",
    canonicalResource: GITHUB_MCP_ENDPOINT_HREF,
    endpointHref: GITHUB_MCP_ENDPOINT_HREF,
    issuer: GITHUB_MCP_ISSUER,
    env: {
      clientIdKey: "GITHUB_MCP_CLIENT_ID",
      clientSecretKey: "GITHUB_MCP_CLIENT_SECRET",
    },
    // `repo` unhides the pull request and issue tools; `read:org` unhides the
    // team reads. `repo` is GitHub's only grain for private repository content,
    // so the consent screen states write access; `GITHUB_MCP_ENDPOINT_HREF` is
    // what keeps the granted token off a write tool.
    scopes: ["repo", "read:org"],
    initialState: {
      authServerIdentity: "oauth:pending",
      status: "disconnected",
    },
  },
} as const satisfies Record<string, BuiltInDefinition>;

export type BuiltInProvider = keyof typeof BUILT_IN_REGISTRY;

/**
 * The built-in that owns `endpoint`, or `undefined` when no entry claims it.
 *
 * A query or a fragment is not part of a canonical built-in resource. Refusing
 * `https://api.githubcopilot.com/mcp/readonly?foo=1` here keeps a supplied URL
 * from inheriting either the pre-registered client or the pinned scopes.
 */
function lookupBuiltIn(endpoint: URL): ResolvedDefinition | undefined {
  if (endpoint.search !== "" || endpoint.hash !== "") return undefined;
  return BY_ENDPOINT.get(endpointKey(endpoint));
}

/**
 * The built-in that owns a STORED `mcp_servers.endpoint_url`, or `undefined`
 * for a user-added server. An unparseable href is a corrupt row, not a
 * built-in, so it resolves to `undefined` rather than throwing at every reader.
 */
function lookupBuiltInHref(endpointUrl: string): ResolvedDefinition | undefined {
  try {
    return lookupBuiltIn(new URL(endpointUrl));
  } catch {
    return undefined;
  }
}

/**
 * The scope baseline for the built-in that owns this stored endpoint, empty for
 * every other endpoint. {@link mcpConsentAsk} unions it with the connection's
 * own scopes, so a user-added server keeps asking for exactly what it
 * discovered.
 */
export function builtInAuthorizationScopes(endpointUrl: string): readonly string[] {
  return lookupBuiltInHref(endpointUrl)?.scopes ?? [];
}

/**
 * The provider key of the built-in that owns this stored endpoint.
 *
 * Derived from the endpoint, never stored — ADR-0093's rule that a provider is
 * a fact about the record, not a column. It is what lets the integrations card
 * find its built-in by identity; the card used to test
 * `canonicalResource.includes("github")`, which any user-added URL containing
 * the word "github" would also satisfy.
 */
export function builtInProviderForEndpoint(endpointUrl: string): BuiltInProvider | undefined {
  return lookupBuiltInHref(endpointUrl)?.provider;
}

/**
 * Origin plus path with any trailing slashes removed. Two hrefs that name the
 * same MCP endpoint produce the same key, and `URL` does the parsing.
 */
function endpointKey(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" ? "/" : path}`;
}

type ResolvedDefinition = BuiltInDefinition & {
  readonly provider: BuiltInProvider;
  readonly issuerOrigin: string;
};

const BY_ENDPOINT: ReadonlyMap<string, ResolvedDefinition> = new Map(
  Object.entries(BUILT_IN_REGISTRY).map(([provider, entry]) => [
    endpointKey(new URL(entry.endpointHref)),
    {
      ...entry,
      // SAFETY: `Object.entries` of BUILT_IN_REGISTRY yields that object's own
      // keys, and `BuiltInProvider` is `keyof typeof BUILT_IN_REGISTRY`. The
      // cast only restores what `Object.entries` widens to `string`.
      provider: provider as BuiltInProvider,
      issuerOrigin: new URL(entry.issuer).origin,
    },
  ]),
);

/**
 * The pre-registered OAuth client for the built-in that owns `endpoint`, if the
 * environment supplies one. GitHub's authorization server supports neither
 * RFC 7591 dynamic registration nor URL-based client ids, so without this the
 * SDK throws at registration (#934). The SDK reads the result from
 * `McpOAuthProvider.clientInformation` and then skips registration.
 *
 * `clientId` decides presence. A secret with no id leaves the built-in absent,
 * so a half-configured environment fails closed instead of sending a secret
 * with no client.
 *
 * `issuerHint` comes from discovery and may name a path under the pinned
 * issuer. The hint must share the pinned issuer's ORIGIN; the returned `issuer`
 * is then the discovered href, so the credential row and the client agree.
 */
export function resolveBuiltInClient(
  endpoint: URL,
  issuerHint?: string | undefined,
): BuiltInOAuthConfig | undefined {
  const definition = lookupBuiltIn(endpoint);
  if (!definition) return undefined;
  const clientId = envFieldValue(definition.env.clientIdKey);
  if (typeof clientId !== "string") return undefined;
  const issuer = issuerHint ? boundIssuer(definition, issuerHint) : definition.issuer;
  if (!issuer) return undefined;
  const clientSecret = envFieldValue(definition.env.clientSecretKey);
  return {
    issuer,
    clientId,
    ...(typeof clientSecret === "string" ? { clientSecret } : {}),
  };
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
