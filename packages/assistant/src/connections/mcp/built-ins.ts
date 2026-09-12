/**
 * Built-in MCP provider registry — the server half of the first-class server
 * catalog (PRD #540 / #934).
 *
 * A built-in is a provider whose endpoint, canonical resource and client-side
 * policy Alfred pins in CODE. `oauth.ts` reads the pre-registered client
 * through `resolveBuiltInClient`, and `persistence.ts` turns one entry into the
 * input of a connection ensure. The next built-in adds one entry here, one
 * entry in `MCP_BUILT_IN_CATALOG`, and edits nothing else.
 *
 * The split is by audience, not by convenience. Everything a BROWSER may read —
 * the tile title, the brand, the blurb — is `MCP_BUILT_IN_CATALOG` in
 * `@alfred/contracts`; everything that decides what Alfred sends to a remote is
 * here. `BUILT_IN_REGISTRY` is keyed by that catalog's union, so neither half
 * can ship a provider the other does not know.
 *
 * Most authorization servers support RFC 7591 dynamic client registration, so
 * most built-ins pin no credential at all: the SDK registers a client on first
 * authorize and persists it on the connection. {@link BuiltInDefinition.staticClient}
 * is the exception, and GitHub is why it exists.
 *
 * For that exception the environment is canonical, and nothing writes the
 * client id or the client secret to a durable row. An operator who rotates
 * `GITHUB_MCP_CLIENT_SECRET` therefore gets the new value on the next token
 * exchange. Reads stay lazy inside `resolveBuiltInClient` so a per-test
 * `process.env` override still works — the same reason
 * `packages/integrations/src/integrations.ts` reads inside `resolve()`.
 * `envFieldValue()` parses one `serverEnvSchema` field per call and caches
 * nothing, and the env keys are part of the entry, so a second provider does
 * not copy hard-coded `GITHUB_MCP_*` names.
 */

import type { McpBuiltInProvider } from "@alfred/contracts";
import { envFieldValue, type ServerEnv } from "@alfred/env/server";

import { hostedEndpointKey } from "../hosted-endpoint";
import {
  GITHUB_MCP_ENDPOINT_HREF,
  GITHUB_MCP_ISSUER,
  LINEAR_MCP_ENDPOINT_HREF,
  MCP_OAUTH_PENDING_IDENTITY,
  NOTION_MCP_ENDPOINT_HREF,
  POLYLANE_MCP_ENDPOINT_HREF,
  SENTRY_MCP_ENDPOINT_HREF,
} from "./constants";

export type BuiltInOAuthConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
};

/**
 * The env keys a built-in may pin, derived from `ServerEnv` by NAME SHAPE.
 *
 * `keyof ServerEnv` was the obvious spelling and it is a hazard: the value this
 * field names is read and sent to a third-party authorization server, so
 * `clientIdKey: "OPENAI_API_KEY"` compiled and exfiltrated. A built-in's client
 * credential is not any env field, it is the pair the environment declares for
 * that provider, and the suffix is what says so.
 *
 * Derived, never listed: a provider that adds `LINEAR_MCP_CLIENT_ID` to
 * `serverEnvSchema` becomes nameable here with no edit, and no other secret
 * ever does.
 */
type McpClientIdEnvKey = Extract<keyof ServerEnv, `${string}_MCP_CLIENT_ID`>;

type McpClientSecretEnvKey = Extract<keyof ServerEnv, `${string}_MCP_CLIENT_SECRET`>;

/**
 * What the registry can answer when a caller asks for a pinned OAuth client.
 *
 * Three different facts used to share one `undefined`, and the SDK reads the
 * absence of a client as "register one dynamically". For "this provider pins
 * none" that is right. For "the pin exists and the environment does not supply
 * it", and for "discovery named an issuer outside the pinned origin", it turns
 * a REFUSAL into a fall-through: the second case is `boundIssuer` refusing to
 * let a pinned client reach a foreign origin, and dynamic registration against
 * that same unverified issuer is the last thing that should follow it.
 *
 * The union makes the caller answer all three. `unavailable` carries the env
 * key so the connection row can state which line an operator has to set.
 */
export type BuiltInClientResolution =
  | { readonly kind: "dynamic" }
  | { readonly kind: "static"; readonly client: BuiltInOAuthConfig }
  | {
      readonly kind: "unavailable";
      readonly reason: "missing_client_id" | "issuer_not_bound";
      readonly envKey: McpClientIdEnvKey;
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
  readonly canonicalResource: string;
  readonly endpointHref: string;
  /**
   * The pre-registered OAuth client this provider's authorization server
   * requires, and the pinned issuer that client belongs to.
   *
   * ABSENT is the normal case: an authorization server that publishes a
   * `registration_endpoint` lets the SDK register a client per connection and
   * persist it, so Alfred configures nothing. Linear, Notion and Sentry all do.
   *
   * PRESENT is the exception GitHub forced (#934): its authorization server
   * supports neither RFC 7591 registration nor a URL-based client id, so the
   * SDK throws at registration unless a client is supplied. The issuer lives in
   * this group rather than beside the endpoint because the group is its only
   * reader — a pinned issuer no code compares against would read as a control
   * and be none.
   */
  readonly staticClient?: {
    readonly issuer: string;
    readonly clientIdKey: McpClientIdEnvKey;
    readonly clientSecretKey: McpClientSecretEnvKey;
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
   * fails to assert the hint, so a write tool served at a read-only path never
   * reaches a published revision. `GITHUB_MCP_ENDPOINT_HREF` holds the measured
   * catalog counts for GitHub's two resources; they are not restated here.
   *
   * The MCP specification calls an annotation a HINT and tells a client never
   * to make a tool-use decision from one. That warning holds, and it does not
   * apply here, because Alfred only ever REFUSES on this field. A lying server
   * can claim `readOnlyHint: true` for a write tool, which this flag does not
   * catch and the resource pin does. Nothing a server can say WIDENS what
   * Alfred admits, so the two controls fail in different directions.
   *
   * False for a user-added server, which keeps whatever catalog it discovered
   * (`mcp.call` still stages an approval for every tool — ADR-0088).
   */
  readonly readOnlyCatalog: boolean;
  /**
   * True when Alfred must negotiate the LEGACY protocol era (`2025-11-25`) with
   * this provider instead of letting the SDK choose the newest both sides
   * support.
   *
   * GitHub declares `x-mcp-header` on `owner` and `repo` for most of its
   * read-only tools. In the modern era the SDK mirrors those argument values
   * into `Mcp-Param-*` request headers, which is a model-selected header
   * channel Alfred has never reviewed, so `assertSafeSchema` refuses any
   * descriptor that declares the keyword. That refusal is not optional garnish:
   * it is the only thing standing between a server-authored schema and that
   * channel. Left alone it also refuses GitHub's whole catalog.
   *
   * The legacy era resolves both. The SDK gates mirroring on the negotiated era
   * alone — `MCP_PROTOCOL_PROFILES[era].mirrorsParamHeaders` is where Alfred
   * records which era does — so `2025-11-25` makes the keyword inert, and the
   * admission rule then has nothing to refuse. Stripping the keyword instead
   * does NOT work: GitHub enforces the header in the modern era. ADR-0095 holds
   * the measured matrix.
   */
  readonly pinLegacyProtocol: boolean;
  readonly initialState: {
    readonly authServerIdentity: string;
    readonly status: "disconnected";
  };
};

/**
 * The row a built-in starts life with: it exists, and it has not authorized
 * yet. Shared because it is the same sentence for every provider.
 */
const BUILT_IN_INITIAL_STATE = {
  authServerIdentity: MCP_OAUTH_PENDING_IDENTITY,
  status: "disconnected",
} as const satisfies BuiltInDefinition["initialState"];

/**
 * The pinned server for every provider `MCP_BUILT_IN_CATALOG` lists.
 *
 * `satisfies Record<McpBuiltInProvider, …>` is the enforcement: a catalog entry
 * with no definition here fails to compile, and a definition here for a
 * provider the catalog does not list fails too. The one initial state is shared
 * because it says the same thing for every provider — the row exists and has
 * not authorized yet.
 */
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
    // `repo` unhides the pull request and issue tools; `read:org` unhides the
    // team reads. `repo` is GitHub's only grain for private repository content,
    // so the consent screen states write access; `GITHUB_MCP_ENDPOINT_HREF` is
    // what keeps the granted token off a write tool.
    scopes: ["repo", "read:org"],
    readOnlyCatalog: true,
    pinLegacyProtocol: true,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  linear: {
    instanceKey: "default",
    canonicalResource: LINEAR_MCP_ENDPOINT_HREF,
    endpointHref: LINEAR_MCP_ENDPOINT_HREF,
    // Every scope the resource declares except `openid` and `email`, which buy
    // an identity claim Alfred does not read. GitHub taught that a server may
    // HIDE a tool the token cannot use rather than fail the call, and nothing in
    // the protocol reports that, so the ask covers the whole catalog and
    // ADR-0088 keeps every call behind an approval.
    scopes: ["read", "write"],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  notion: {
    instanceKey: "default",
    canonicalResource: NOTION_MCP_ENDPOINT_HREF,
    endpointHref: NOTION_MCP_ENDPOINT_HREF,
    // The one scope the resource declares. Notion grades access by the pages
    // the owner shares with the integration at consent time, not by scope.
    scopes: ["default"],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  sentry: {
    instanceKey: "default",
    canonicalResource: SENTRY_MCP_ENDPOINT_HREF,
    endpointHref: SENTRY_MCP_ENDPOINT_HREF,
    // Every scope the resource declares. `org:read` alone hides the issue and
    // event tools that make the server worth connecting.
    scopes: ["org:read", "project:write", "team:write", "event:write"],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
  polylane: {
    instanceKey: "default",
    canonicalResource: POLYLANE_MCP_ENDPOINT_HREF,
    endpointHref: POLYLANE_MCP_ENDPOINT_HREF,
    // EMPTY on measured evidence, not by omission: neither the protected
    // resource metadata nor the authorization server metadata declares a
    // `scopes_supported` member, so there is no scope to name and an invented
    // one is a token request the server can refuse. The grant is graded by the
    // workspace the account holder approves at consent time, the way Notion
    // grades by shared pages. A scope the server later DEMANDS still widens the
    // next consent, because `mcpConsentAsk` unions this baseline with the
    // connection's own scopes.
    scopes: [],
    readOnlyCatalog: false,
    pinLegacyProtocol: false,
    initialState: BUILT_IN_INITIAL_STATE,
  },
} as const satisfies Record<McpBuiltInProvider, BuiltInDefinition>;

/**
 * The provider key space is the CATALOG's, re-exported under the name this
 * directory already uses. It is not `keyof typeof BUILT_IN_REGISTRY`: that
 * spelling would let this file widen the key space on its own, and the browser
 * half would not know.
 */
export type BuiltInProvider = McpBuiltInProvider;

/**
 * The built-in that owns `endpoint`, or `undefined` when no entry claims it.
 *
 * A query or a fragment is not part of a canonical built-in resource. Refusing
 * `https://api.githubcopilot.com/mcp/readonly?foo=1` here keeps a supplied URL
 * from inheriting either the pre-registered client or the pinned scopes.
 */
function lookupBuiltIn(endpoint: URL): ResolvedDefinition | undefined {
  if (endpoint.search !== "" || endpoint.hash !== "") return undefined;

  return BY_ENDPOINT.get(hostedEndpointKey(endpoint));
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
 * Derived from {@link BuiltInDefinition} rather than restated, so a third
 * client-side policy field is one edit in the definition above.
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
 * This stays OFF the `connections/mcp` barrel, like
 * {@link builtInAuthorizationScopes}. It is a CLIENT CONFIGURATION bundle, and
 * its only caller is `liveClientFactory` in this directory. The risk gate
 * outside this directory asks a different, narrower question and gets
 * {@link builtInReadOnlyResource} instead.
 */
type BuiltInClientPolicy = Pick<BuiltInDefinition, "readOnlyCatalog" | "pinLegacyProtocol">;

export function builtInClientPolicy(endpointUrl: string): BuiltInClientPolicy {
  const definition = lookupBuiltInHref(endpointUrl);

  return {
    readOnlyCatalog: definition?.readOnlyCatalog ?? false,
    pinLegacyProtocol: definition?.pinLegacyProtocol ?? false,
  };
}

/**
 * True when this STORED endpoint is a built-in READ-ONLY protected resource.
 *
 * One question, one answer, and the one name on the barrel. The `mcp.call` risk
 * gate asks whether the RESOURCE is trusted to serve reads before it grants a
 * structural downgrade (ADR-0096). That is a resource-trust question, so it
 * must not travel through the client-configuration bundle above: the gate has
 * no business knowing which protocol era Alfred negotiates.
 *
 * False for every endpoint no built-in claims, and false for a corrupt stored
 * href, so an uncertainty keeps the `high` floor.
 */
export function builtInReadOnlyResource(endpointUrl: string): boolean {
  return lookupBuiltInHref(endpointUrl)?.readOnlyCatalog ?? false;
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

type ResolvedDefinition = BuiltInDefinition & {
  readonly provider: BuiltInProvider;
  /** Origin of {@link BuiltInDefinition.staticClient}'s issuer, absent without one. */
  readonly issuerOrigin?: string;
};

const BY_ENDPOINT: ReadonlyMap<string, ResolvedDefinition> = new Map(
  Object.entries(BUILT_IN_REGISTRY).map(([provider, entry]): [string, ResolvedDefinition] => {
    // The registry preserves each entry's literal type, so an entry that pins
    // no static client has NO `staticClient` property to read. Widening to the
    // declared shape once here is what lets one loop serve both kinds.
    const definition: BuiltInDefinition = entry;

    return [
      hostedEndpointKey(new URL(definition.endpointHref)),
      {
        ...definition,
        // SAFETY: `Object.entries` of BUILT_IN_REGISTRY yields that object's
        // own keys, and the registry `satisfies Record<McpBuiltInProvider, …>`,
        // so those keys are exactly `BuiltInProvider`. The cast only restores
        // what `Object.entries` widens to `string`.
        provider: provider as BuiltInProvider,
        ...(definition.staticClient
          ? { issuerOrigin: new URL(definition.staticClient.issuer).origin }
          : {}),
      },
    ];
  }),
);

/**
 * How the built-in that owns `endpoint` wants its OAuth client obtained.
 *
 * GitHub's authorization server supports neither RFC 7591 dynamic registration
 * nor URL-based client ids, so without a pinned client the SDK throws at
 * registration (#934). Every other built-in, and every user-added server,
 * relies on the server registering one.
 *
 * The three answers are distinct on purpose (see {@link BuiltInClientResolution}).
 * `dynamic` is the normal case and the caller must let the SDK register.
 * `unavailable` is a REFUSAL and the caller must fail the authorize: falling
 * through to dynamic registration is what turned a refused issuer into a
 * registration attempt against that same unverified origin.
 *
 * `clientId` decides presence. A secret with no id is `missing_client_id`, so a
 * half-configured environment fails closed instead of sending a secret with no
 * client.
 *
 * `issuerHint` comes from discovery and may name a path under the pinned
 * issuer. The hint must share the pinned issuer's ORIGIN; the returned `issuer`
 * is then the discovered href, so the credential row and the client agree.
 */
export function resolveBuiltInClient(
  endpoint: URL,
  issuerHint?: string | undefined,
): BuiltInClientResolution {
  const definition = lookupBuiltIn(endpoint);
  const staticClient = definition?.staticClient;

  if (!staticClient) return { kind: "dynamic" };
  const envKey = staticClient.clientIdKey;
  const clientId = envFieldValue(envKey);

  if (typeof clientId !== "string") {
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
      ...(typeof clientSecret === "string" ? { clientSecret } : {}),
    },
  };
}

/** The sentence a refused pin puts on the connection row, for the owner to read. */
export function builtInClientUnavailableMessage(
  resolution: Extract<BuiltInClientResolution, { kind: "unavailable" }>,
): string {
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
