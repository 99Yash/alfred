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
   * OAuth scopes Alfred asks for on EVERY authorize for this provider.
   *
   * The remote MCP server decides what its `tools/list` contains from the
   * token it is given, and GitHub's server hides a tool whose scope the token
   * lacks instead of failing the call. A `gho_` token with an empty scope
   * therefore produced a catalog of 8 tools with no pull request or issue tool
   * in it, while the same read-only endpoint returned 28 tools to a token
   * carrying `repo` and `read:org`. Nothing in the protocol reports that
   * shortfall, so the ask cannot be discovered at run time: it is pinned here
   * beside the endpoint the scopes belong to.
   *
   * This is the BASELINE, not the whole ask. `beginAuthorization` unions it
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
    // `repo` is what unhides the pull request and issue tools; `read:org` is
    // what unhides the team reads. `repo` is GitHub's only grain for private
    // repository content, so the consent screen states write access — the
    // pinned read-only endpoint is what keeps the granted token from reaching
    // a write tool. See `GITHUB_MCP_ENDPOINT_HREF`.
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
 * The scope baseline for the built-in that owns `endpoint`, empty for every
 * other endpoint. The authorize step unions this with the connection's own
 * scopes, so a user-added server keeps asking for exactly what it discovered.
 */
export function builtInAuthorizationScopes(endpoint: URL): readonly string[] {
  return lookupBuiltIn(endpoint)?.scopes ?? [];
}

/**
 * Origin plus path with any trailing slashes removed. Two hrefs that name the
 * same MCP endpoint produce the same key, and `URL` does the parsing.
 */
function endpointKey(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" ? "/" : path}`;
}

type ResolvedDefinition = BuiltInDefinition & { readonly issuerOrigin: string };

const BY_ENDPOINT: ReadonlyMap<string, ResolvedDefinition> = new Map(
  Object.values(BUILT_IN_REGISTRY).map((entry) => [
    endpointKey(new URL(entry.endpointHref)),
    { ...entry, issuerOrigin: new URL(entry.issuer).origin },
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
