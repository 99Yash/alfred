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
  /**
   * True when the provider's endpoint is a READ-ONLY protected resource, so
   * every descriptor in its catalog must assert `annotations.readOnlyHint`.
   *
   * ADR-0094 pins the read-only resource, and that pin is one character of one
   * constant. This flag is the SECOND, independent condition the same catalog
   * has to satisfy: `McpRawClient` refuses the whole refresh when any tool
   * fails to assert the hint, so a write tool served at `/mcp/readonly` never
   * reaches a published revision. Measured on 2026-09-03: all 28 tools at
   * `/mcp/readonly` carry `readOnlyHint: true`, and the 19 write tools that
   * only the `/mcp` root serves all carry `readOnlyHint: false`. The name set
   * GitHub serves at `/mcp/readonly` is byte-identical to the `readOnlyHint:
   * true` subset of `/mcp`, so the resource and the annotation agree today.
   *
   * The MCP specification calls an annotation a HINT and tells a client never
   * to make a tool-use decision from one. That warning holds, and it does not
   * apply here, because Alfred only ever REFUSES on this field. A lying server
   * can claim `readOnlyHint: true` for a write tool, which this flag does not
   * catch and the resource pin does. Nothing a server can say WIDENS what
   * Alfred admits, so the two controls fail in different directions.
   *
   * Absent for a user-added server, which keeps whatever catalog it discovered
   * (`mcp.call` still stages an approval for every tool — ADR-0088).
   */
  readonly readOnlyCatalog: boolean;
  /**
   * True when Alfred must negotiate the LEGACY protocol era (`2025-11-25`) with
   * this provider instead of letting the SDK choose the newest both sides
   * support.
   *
   * GitHub declares `x-mcp-header` on `owner` and `repo` for 21 of the 28 tools
   * at `/mcp/readonly`. In the modern era the SDK mirrors those argument values
   * into `Mcp-Param-*` request headers, which is a model-selected header
   * channel Alfred has never reviewed, so `assertSafeSchema` refuses any
   * descriptor that declares the keyword. That refusal is not optional garnish:
   * it is the only thing standing between a server-authored schema and that
   * channel. Left alone it also refuses GitHub's whole catalog.
   *
   * The legacy era resolves both. The SDK gates mirroring on the negotiated era
   * alone, so `2025-11-25` makes the keyword inert, and the admission rule then
   * has nothing to refuse. Measured on 2026-09-03 against `/mcp/readonly`: the
   * legacy era lists the same 28 tools, sends no `Mcp-Param-*` header, and
   * `list_branches` succeeds with `owner` and `repo` in the request body.
   * Stripping the keyword instead does NOT work — GitHub enforces the header in
   * the modern era and answers `header mismatch: missing Mcp-Param-repo header
   * for parameter "repo"`. ADR-0095.
   */
  readonly pinLegacyProtocol: boolean;
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
    readOnlyCatalog: true,
    pinLegacyProtocol: true,
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
 * How `McpRawClient` must be configured for a STORED endpoint — the two facts
 * only the registry knows, in the one shape `liveClientFactory` spreads.
 *
 * They travel together because they answer one question, "what does Alfred owe
 * this endpoint that it does not owe an arbitrary one", and because keeping
 * them together means a third built-in adds one registry entry rather than a
 * third reader. The client itself takes them as two plain flags: it must not
 * reach the registry, or it would know which servers Alfred trusts.
 *
 * Every field is `false` for an endpoint no built-in claims. That default never
 * admits a tool the endpoint would not have served anyway, and a user-added
 * server is allowed both a write catalog and the newest protocol era.
 *
 * Unlike {@link builtInAuthorizationScopes}, this one IS on the package barrel.
 * It has a second product reader outside this directory: the `mcp.call` risk
 * gate asks whether the endpoint is a read-only protected resource before it
 * grants a structural downgrade (ADR-0096). The scope baseline has no such
 * reader, which is why it stays behind `consent.ts`.
 */
export interface BuiltInClientPolicy {
  readonly readOnlyCatalog: boolean;
  readonly pinLegacyProtocol: boolean;
}

export function builtInClientPolicy(endpointUrl: string): BuiltInClientPolicy {
  const definition = lookupBuiltInHref(endpointUrl);
  return {
    readOnlyCatalog: definition?.readOnlyCatalog ?? false,
    pinLegacyProtocol: definition?.pinLegacyProtocol ?? false,
  };
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
