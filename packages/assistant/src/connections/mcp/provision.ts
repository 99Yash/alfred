/**
 * Generic MCP server connection (PRD #1004) — the product door that turns a
 * user-supplied endpoint URL into a durable server definition plus one named
 * connection.
 *
 * Nothing is persisted until a *probe* answers. The probe is a transient
 * `McpRawClient` over the same `HostedMcpEndpointAuthorizer` the live manager
 * uses, so the DNS pin, the private-range refusal, the redirect guard, protocol
 * negotiation, and schema admission that protect a callable connection also
 * decide whether the URL is admissible at all.
 *
 * The probe has exactly two admissible answers, and BOTH create the row pair:
 *
 *  - a reachable no-auth server is connected on the spot, and the manager's
 *    normal connect path publishes its first catalog revision;
 *  - a server that answers with an authorization challenge becomes a connection
 *    in `auth_required`, which the caller then sends through the same OAuth
 *    door a built-in uses. Alfred registers its own client through RFC 7591
 *    where the authorization server allows it, so a server with no pinned
 *    credential in `built-ins.ts` still connects.
 *
 * An owner-supplied API key is a third variant, not a third answer: the probe
 * carries the key, a challenge is the endpoint rejecting it (a refusal, since
 * no consent screen belongs on this path), and a successful probe seals the key
 * before the manager opens the live session.
 *
 * The probe is discarded once it has answered, so the manager opens its own
 * generation. That is one extra handshake per add, and it buys the rule this
 * module keeps: a URL Alfred REFUSES leaves no rows behind. A challenge is not
 * a refusal — it is the server naming its next step — so the row is what
 * carries that step to the consent screen and back.
 *
 * The rule has one hole, and it is a second session, not a second probe. The
 * row pair is committed before `getReadyClient` opens the manager's own
 * session, so a server that admits the probe and then refuses the successor —
 * a per-IP session cap, a free-tier limit, credentials that apply only to the
 * second connect — leaves a connection in `failed` with no catalog. The card
 * shows it and the owner can disconnect it; a probe that is also the live
 * session is what would close the hole, and this module does not have one.
 */

import { redacted, type McpAddServerAuth, type McpApiKeyAuth } from "@alfred/contracts";
import { persistApiKeyCredential } from "./api-key";
import { MCP_DEFAULT_REQUEST_TIMEOUT_MS, McpRawClient, type McpClientAuth } from "./client";
import { builtInClientPolicy, builtInProviderForEndpoint } from "./built-ins";
import { MCP_OAUTH_PENDING_IDENTITY } from "./constants";
import {
  getMcpEndpointAuthorizer,
  validatePublicHttpsEndpoint,
  type McpApiKeyCredentialReader,
} from "./endpoint-authorization";
import {
  isMcpAuthorizationChallenge,
  isMcpEndpointRefusal,
  McpApiKeyRejectedError,
} from "./errors";
import { hostedEndpointKey } from "../hosted-endpoint";
import { ensureConnection } from "./persistence";
import { getMcpConnectionManager } from "./runtime";

/** The one instance slot this slice mints; named accounts arrive with #1005. */
const USER_MCP_DEFAULT_INSTANCE_KEY = "default";

/** Identity the transient probe client reports in its own errors and snapshots. */
const PROBE_CONNECTION_ID = "probe";

/**
 * The whole-add deadline.
 *
 * `MCP_DEFAULT_REQUEST_TIMEOUT_MS` bounds ONE request. The probe's catalog
 * refresh pages up to `DEFAULT_MAX_CATALOG_PAGES` times, each with its own
 * fresh budget, so a slow-but-answering server can hold the add request open
 * for the better part of an hour without ever exceeding a per-request timeout.
 * This is the aggregate bound the per-request one cannot express. It covers the
 * paging loop, which is the unbounded part; the handshake before it takes no
 * signal and keeps the per-request budget.
 */
const ADD_SERVER_DEADLINE_MS = 60_000;

/**
 * What the add door did. Both outcomes leave one connection row; they differ in
 * what has to happen next.
 *
 * `auth_required` carries the connection id because the browser's next hop is
 * that connection's authorize route. The name matches the persisted
 * `mcp_connections.status` the same answer writes, so the card and the add form
 * report one state, not two spellings of it.
 */
export type AddUserMcpServerResult = {
  readonly outcome: "connected" | "auth_required";
  readonly connectionId: string;
};

/**
 * A URL that a built-in already owns.
 *
 * The generic door mints `instanceKey: "default"` and a canonical resource
 * derived from the endpoint — the identical pair the GitHub built-in uses — so
 * pasting a built-in's endpoint would land on the built-in's own rows and
 * report a connection the owner never created. Worse, it would arrive without
 * the registry's read-only catalog pin (ADR-0094) or its protocol-era pin
 * (ADR-0095), because those are keyed on the endpoint the REGISTRY supplied.
 * Built-ins are connected through their own door.
 */
export class BuiltInMcpEndpointError extends Error {
  constructor(readonly provider: string) {
    super(`This endpoint is the built-in ${provider} server. Connect it from its own card.`);
    this.name = "BuiltInMcpEndpointError";
  }
}

export interface AddUserMcpServerInput {
  readonly userId: string;
  /** Raw owner input; validated and pinned before any network call. */
  readonly endpointUrl: string;
  /** Optional display name; defaults to the endpoint host. */
  readonly label?: string;
  /**
   * Optional owner-supplied credential. Absence means no-auth, or OAuth if the
   * endpoint answers with an authorization challenge.
   */
  readonly auth?: McpAddServerAuth;
  /** The caller's own deadline, unioned with this module's aggregate bound. */
  readonly signal?: AbortSignal;
}

/**
 * Validate, probe, then persist one generic MCP connection.
 *
 * A URL-level or DNS-level refusal throws a `HostedEndpointError` (URL shape) or
 * a `fetch` failure carrying the `EBLOCKEDHOST` cause (private resolution); a
 * built-in's own endpoint throws {@link BuiltInMcpEndpointError}. All are the
 * caller's to map; none creates a row. `auth_required` is a normal answer, not
 * an error: the row exists and waits for the owner's consent.
 *
 * With an owner-supplied API key the probe carries the key, so a challenge is
 * the endpoint rejecting that key and throws {@link McpApiKeyRejectedError} —
 * there is no consent screen on this path. A successful probe seals the key in
 * the same store the live manager reads it back from.
 */
export async function addUserMcpServer(
  input: AddUserMcpServerInput,
): Promise<AddUserMcpServerResult> {
  const endpoint = canonicalEndpoint(validatePublicHttpsEndpoint(input.endpointUrl));
  const resource = hostedEndpointKey(endpoint);
  // Asked on the KEY, not the href: the registry refuses to claim a URL that
  // carries a query, so `…/mcp/readonly?x=1` would otherwise walk straight past
  // the built-in it plainly names.
  const builtIn = builtInProviderForEndpoint(resource);

  if (builtIn) throw new BuiltInMcpEndpointError(builtIn);
  const deadline = AbortSignal.timeout(ADD_SERVER_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const apiKey = apiKeyAuthFromAddServerAuth(input.auth);

  // The probe reads the owner's key from memory; only the successful path seals
  // it. The reader shape is the same one the live client gets from the store.
  const probeAuth: McpClientAuth =
    apiKey === undefined
      ? { mode: "none" }
      : { mode: "api_key", reader: apiKeyReaderForWireKey(apiKey) };

  const requiresAuthorization = await probeRequiresAuthorization(endpoint, signal, probeAuth);

  // A challenge with a key configured is the endpoint's answer about the KEY.
  // There is no authorization server to send the browser to, so this refuses
  // rather than parking a row no consent screen can finish.
  if (requiresAuthorization && apiKey) throw new McpApiKeyRejectedError();

  const connection = await ensureConnection({
    userId: input.userId,
    label: input.label?.trim() || endpoint.hostname,
    instanceKey: USER_MCP_DEFAULT_INSTANCE_KEY,
    // The endpoint KEY is the canonical resource for a user-added server, not
    // its href: the resource is the thing, the query is a parameter of one call
    // to it. A different path stays a different resource.
    canonicalResource: resource,
    endpoint,
    endpointAuthority: "caller",
    // `initialState` writes on INSERT only, so a re-add of a server that is
    // already connected keeps its status. That is the property that lets the
    // owner re-add a URL to correct its label without demoting a live row.
    ...(requiresAuthorization
      ? {
          initialState: { authServerIdentity: MCP_OAUTH_PENDING_IDENTITY, status: "auth_required" },
        }
      : {}),
  });

  // No credential exists yet, so there is nothing to connect WITH: the consent
  // round trip ends at the OAuth callback, which is what opens the session.
  if (requiresAuthorization) return { outcome: "auth_required", connectionId: connection.id };

  if (apiKey) {
    await persistApiKeyCredential({
      connectionId: connection.id,
      userId: input.userId,
      placement: apiKey.placement,
      value: apiKey.value,
    });
    // A live generation holds a client whose key reader closed over the row this
    // write just replaced. Drop it so the connect below re-reads the new secret
    // instead of serving the old one behind a `ready` card.
    await getMcpConnectionManager().invalidateLiveClient(connection.id);
  }

  await getMcpConnectionManager().getReadyClient(connection.id);

  return { outcome: "connected", connectionId: connection.id };
}

/**
 * The endpoint as Alfred stores it, with any trailing slash removed.
 *
 * `URL` does not normalize a trailing slash, so `…/mcp` and `…/mcp/` arrive as
 * two URLs. Left alone they become two server rows, two catalogs and two tool
 * namespaces for one server. Normalizing HERE — before the identity, the
 * built-in refusal and the stored href are derived — is what keeps all three
 * reading one path.
 */
function canonicalEndpoint(url: URL): URL {
  const endpoint = new URL(hostedEndpointKey(url));

  endpoint.search = url.search;

  return endpoint;
}

/**
 * Every arm of the create route's auth union, keyed by `kind`.
 *
 * This is the compile-time gate item 21 asks for. A `switch` with a `never`
 * default cannot prove it while the schema has ONE arm: TypeScript collapses a
 * single-member discriminated union, so the discriminant is not a union and the
 * object is never narrowed to `never`. A `satisfies`-checked map keyed by
 * `McpAddServerAuth["kind"]` is exhaustive under the same compiler, and adding
 * an arm to `mcpAddServerAuthSchema` fails `check-types` here until the arm gets
 * a mapping — instead of silently falling through to `undefined` (the defect at
 * the old ternary).
 */
const ADD_SERVER_AUTH_CREDENTIAL = {
  api_key: (auth: McpApiKeyAuth): McpApiKeyAuth | undefined => auth,
} satisfies {
  readonly [K in McpAddServerAuth["kind"]]: (
    auth: Extract<McpAddServerAuth, { kind: K }>,
  ) => McpApiKeyAuth | undefined;
};

/** Narrow the create route's auth input to the wire API-key credential. */
function apiKeyAuthFromAddServerAuth(
  auth: McpAddServerAuth | undefined,
): McpApiKeyAuth | undefined {
  if (auth === undefined) return undefined;

  const read = ADD_SERVER_AUTH_CREDENTIAL[auth.kind];

  return read(auth);
}

/**
 * The in-memory reader the probe carries. The shape matches the store reader
 * `readApiKeyAuthForConnection` returns, so the probe and the live client
 * exercise the same transport path; only the source of the plaintext differs.
 */
function apiKeyReaderForWireKey(apiKey: McpApiKeyAuth): McpApiKeyCredentialReader {
  return {
    placement: async () => apiKey.placement,
    secret: async () => redacted(apiKey.value),
  };
}

/**
 * True when the endpoint answers with an authorization challenge instead of an
 * MCP session. The transport throws `UnauthorizedError` on a 401 when no
 * `authProvider` can retry, which is exactly the no-credentials probe below.
 */
async function probeRequiresAuthorization(
  endpoint: URL,
  signal: AbortSignal,
  auth: McpClientAuth,
): Promise<boolean> {
  const client = new McpRawClient({
    connectionId: PROBE_CONNECTION_ID,
    endpoint: { endpointUrl: endpoint.href, endpointOrigin: endpoint.origin },
    endpointAuthorizer: getMcpEndpointAuthorizer(),
    requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS,
    // The SAME policy the live manager will spread for this endpoint, from the
    // one function that derives it. Restating the shape here is how the probe
    // and the live client come to disagree about an endpoint's protocol era.
    // The probe never carries an OAuth arm: an unauthenticated connect IS the
    // probe, and an owner-supplied key rides the protocol requester.
    auth,
    ...builtInClientPolicy(endpoint.href),
  });

  try {
    await client.connect();
    // Fetch the catalog too, so a server whose descriptors Alfred refuses (an
    // unsafe schema, an oversized catalog) is rejected before a row exists.
    await client.refreshCatalog(signal);
  } catch (error) {
    if (isMcpAuthorizationChallenge(error)) return true;

    throw error;
  } finally {
    // `terminateSession: true`: the probe is the only owner of this session and
    // it is leaving. Without it a legacy-era server keeps an orphan session for
    // its own idle timeout after every add, successful or not.
    await client.close({ terminateSession: true }).catch(() => undefined);
  }

  return false;
}

/**
 * True for a failure the supplied URL caused, and false for one Alfred caused.
 *
 * The add door reaches the network AND the database, and only the first is the
 * owner's doing. The caller maps this to a 4xx and lets everything else — a
 * failed insert, a missing key — stay a 5xx.
 */
export function isAddUserMcpServerRefusal(error: unknown): boolean {
  return error instanceof BuiltInMcpEndpointError || isMcpEndpointRefusal(error);
}
