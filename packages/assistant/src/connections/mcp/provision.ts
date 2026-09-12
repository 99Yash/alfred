/**
 * Generic MCP server connection (PRD #1004) — the product door that turns a
 * user-supplied endpoint URL into a durable server definition plus one named
 * connection.
 *
 * Nothing is persisted until a *probe* answers. The probe is a transient
 * `McpRawClient` over the same `HostedMcpEndpointAuthorizer` the live manager
 * uses, so the DNS pin, the private-range refusal, the redirect guard, protocol
 * negotiation, and schema admission that protect a callable connection also
 * decide whether the URL is admissible at all. A server that answers with an
 * authorization challenge is reported and leaves no rows; a server that answers
 * as a reachable no-auth MCP server is then created and its first catalog
 * revision is published by the manager's normal connect path.
 *
 * The probe is discarded once it has answered, so the manager opens its own
 * generation. That is one extra handshake per add, and it is the price of the
 * "no rows for a server Alfred cannot use" rule this slice carries.
 */

import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { MCP_DEFAULT_REQUEST_TIMEOUT_MS, McpRawClient } from "./client";
import { HostedMcpEndpointAuthorizer } from "./endpoint-authorization";
import { validatePinnedHttpsEndpoint, validatePublicWebUrl } from "../hosted-endpoint";
import { ensureConnection, type McpConnectionWithServer } from "./persistence";
import { getMcpConnectionManager } from "./runtime";

/** The one instance slot this slice mints; named accounts arrive with #1005. */
const USER_MCP_DEFAULT_INSTANCE_KEY = "default";

/** Identity the transient probe client reports in its own errors and snapshots. */
const PROBE_CONNECTION_ID = "probe";

/** How far the auth predicate follows an `Error.cause` chain. */
const MAX_AUTH_CAUSE_DEPTH = 4;

const endpointAuthorizer = new HostedMcpEndpointAuthorizer();

export interface AddUserMcpServerInput {
  readonly userId: string;
  /** Raw owner input; validated and pinned before any network call. */
  readonly endpointUrl: string;
  /** Optional display name; defaults to the endpoint host. */
  readonly label?: string;
}

export type AddUserMcpServerResult =
  | { readonly outcome: "connected"; readonly connection: McpConnectionWithServer }
  | { readonly outcome: "auth_required" };

/**
 * Validate, probe, then persist one generic MCP connection.
 *
 * A URL-level or DNS-level refusal throws a `HostedEndpointError` (URL shape) or
 * a `fetch` failure carrying the `EBLOCKEDHOST` cause (private resolution).
 * Both are the caller's to map; neither creates a row. `auth_required` is a
 * normal answer, not an error: it is the probe's one unsupported outcome.
 */
export async function addUserMcpServer(
  input: AddUserMcpServerInput,
): Promise<AddUserMcpServerResult> {
  const endpoint = validatedHostedEndpoint(input.endpointUrl);

  if (await probeRequiresAuthorization(endpoint)) return { outcome: "auth_required" };

  const connection = await ensureConnection({
    userId: input.userId,
    label: input.label?.trim() || endpoint.hostname,
    instanceKey: USER_MCP_DEFAULT_INSTANCE_KEY,
    // The endpoint href IS the canonical resource for a user-added server. A
    // second add of the same URL therefore reuses the server definition, and a
    // different path is a different resource.
    canonicalResource: endpoint.href,
    endpoint,
    endpointAuthority: "caller",
  });

  await getMcpConnectionManager().getReadyClient(connection.id);

  return { outcome: "connected", connection };
}

/**
 * The full guard stack applied to a brand-new URL: public web shape, then the
 * pinned-HTTPS rules the stored row will be held to on every later connect
 * (`https`, no fragment, no embedded credentials, default port).
 */
function validatedHostedEndpoint(input: string): URL {
  const publicUrl = validatePublicWebUrl(input);

  return validatePinnedHttpsEndpoint(publicUrl, publicUrl.origin);
}

/**
 * True when the endpoint answers with an authorization challenge instead of an
 * MCP session. The transport throws `UnauthorizedError` on a 401 when no
 * `authProvider` can retry, which is exactly the no-credentials probe below.
 */
async function probeRequiresAuthorization(endpoint: URL): Promise<boolean> {
  const client = new McpRawClient({
    connectionId: PROBE_CONNECTION_ID,
    endpoint: { endpointUrl: endpoint.href, endpointOrigin: endpoint.origin },
    endpointAuthorizer,
    requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS,
    // No OAuth provider and no auth header: an unauthenticated connect is the
    // probe. `readOnlyCatalog`/`pinLegacyProtocol` stay at their false default,
    // matching `builtInClientPolicy` for this endpoint on the live manager.
  });

  try {
    await client.connect();
    // Fetch the catalog too, so a server whose descriptors Alfred refuses (an
    // unsafe schema, an oversized catalog) is rejected before a row exists.
    await client.refreshCatalog();
  } catch (error) {
    if (isMcpAuthorizationRequiredError(error)) return true;

    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }

  return false;
}

function isMcpAuthorizationRequiredError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_AUTH_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (isAuthorizationChallenge(current)) return true;

    current = current.cause;
  }

  return false;
}

function isAuthorizationChallenge(error: unknown): boolean {
  return (
    UnauthorizedError.isInstance(error) || (error instanceof SdkHttpError && error.status === 401)
  );
}
