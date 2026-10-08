/**
 * Add a user-supplied MCP server. A throwaway probe, with the live client's guards,
 * runs first, so a refused URL leaves no rows. A no-auth server connects now;
 * an auth challenge gives an `auth_required` row for the OAuth flow.
 * Known gap: if the probe passes but the second session fails, the row stays `failed`.
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

/** Only one instance per server for now. */
const USER_MCP_DEFAULT_INSTANCE_KEY = "default";

const PROBE_CONNECTION_ID = "probe";

/** Deadline for the whole catalog paging loop. Each page gets its own per-request timeout. */
const ADD_SERVER_DEADLINE_MS = 60_000;

/** Both outcomes leave one row. `auth_required` carries the id for the authorize route. */
export type AddUserMcpServerResult = {
  readonly outcome: "connected" | "auth_required";
  readonly connectionId: string;
};

/** A built-in's URL. Adding it here would share the built-in's rows without its ADR-0094/0095 pins. */
export class BuiltInMcpEndpointError extends Error {
  constructor(readonly provider: string) {
    super(`This endpoint is the built-in ${provider} server. Connect it from its own card.`);
    this.name = "BuiltInMcpEndpointError";
  }
}

export interface AddUserMcpServerInput {
  readonly userId: string;
  /** Raw owner input, validated before any network call. */
  readonly endpointUrl: string;
  /** Optional display name; defaults to the endpoint host. */
  readonly label?: string;
  /** Without it: no auth, or OAuth if the endpoint challenges. */
  readonly auth?: McpAddServerAuth;
  /** The caller's own deadline, unioned with this module's aggregate bound. */
  readonly signal?: AbortSignal;
}

/**
 * Validate, probe, then persist. Refusals throw and create no row.
 * With an API key, a challenge throws {@link McpApiKeyRejectedError}; success seals the key.
 */
export async function addUserMcpServer(
  input: AddUserMcpServerInput,
): Promise<AddUserMcpServerResult> {
  const endpoint = canonicalEndpoint(validatePublicHttpsEndpoint(input.endpointUrl));
  const resource = hostedEndpointKey(endpoint);
  // Check the key, not the href: the registry ignores URLs with a query.
  const builtIn = builtInProviderForEndpoint(resource);

  if (builtIn) throw new BuiltInMcpEndpointError(builtIn);
  const deadline = AbortSignal.timeout(ADD_SERVER_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const apiKey = apiKeyAuthFromAddServerAuth(input.auth);

  // The probe reads the key from memory. Only success seals it.
  const probeAuth: McpClientAuth =
    apiKey === undefined
      ? { mode: "none" }
      : { mode: "api_key", reader: apiKeyReaderForWireKey(apiKey) };

  const requiresAuthorization = await probeRequiresAuthorization(endpoint, signal, probeAuth);

  // With a key, a challenge means the key was rejected.
  if (requiresAuthorization && apiKey) throw new McpApiKeyRejectedError();

  const connection = await ensureConnection({
    userId: input.userId,
    label: input.label?.trim() || endpoint.hostname,
    instanceKey: USER_MCP_DEFAULT_INSTANCE_KEY,
    // The canonical resource is the endpoint key, so a query does not make a new resource.
    canonicalResource: resource,
    endpoint,
    endpointAuthority: "caller",
    // `initialState` applies on insert only, so a re-add keeps a live row's status.
    ...(requiresAuthorization
      ? {
          initialState: { authServerIdentity: MCP_OAUTH_PENDING_IDENTITY, status: "auth_required" },
        }
      : {}),
  });

  // No credential yet. The OAuth callback opens the session.
  if (requiresAuthorization) return { outcome: "auth_required", connectionId: connection.id };

  if (apiKey) {
    await persistApiKeyCredential({
      connectionId: connection.id,
      userId: input.userId,
      placement: apiKey.placement,
      value: apiKey.value,
    });
    // Drop the live client so the connect below reads the new key, not the old one.
    await getMcpConnectionManager().invalidateLiveClient(connection.id);
  }

  await getMcpConnectionManager().getReadyClient(connection.id);

  return { outcome: "connected", connectionId: connection.id };
}

/** Strip a trailing slash, or `…/mcp` and `…/mcp/` become two servers. */
function canonicalEndpoint(url: URL): URL {
  const endpoint = new URL(hostedEndpointKey(url));

  endpoint.search = url.search;

  return endpoint;
}

/**
 * One entry per auth `kind`; a new arm fails `check-types` here.
 * A `never` switch cannot check a one-arm union, because TypeScript collapses it.
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

/** Same shape as `readApiKeyAuthForConnection`, so probe and live client share one path. */
function apiKeyReaderForWireKey(apiKey: McpApiKeyAuth): McpApiKeyCredentialReader {
  return {
    placement: async () => apiKey.placement,
    secret: async () => redacted(apiKey.value),
  };
}

/** True when the endpoint answers with an auth challenge instead of a session. */
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
    // Same policy as the live client. The probe never uses OAuth.
    auth,
    ...builtInClientPolicy(endpoint.href),
  });

  try {
    await client.connect();
    // Fetch the catalog too, so a refused catalog fails before a row exists.
    await client.refreshCatalog(signal);
  } catch (error) {
    if (isMcpAuthorizationChallenge(error)) return true;

    throw error;
  } finally {
    // Otherwise a legacy-era server keeps an orphan session until its idle timeout.
    await client.close({ terminateSession: true }).catch(() => undefined);
  }

  return false;
}

/** True when the URL caused the failure (4xx), false when Alfred did (5xx). */
export function isAddUserMcpServerRefusal(error: unknown): boolean {
  return error instanceof BuiltInMcpEndpointError || isMcpEndpointRefusal(error);
}
