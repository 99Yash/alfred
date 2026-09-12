import {
  Errors,
  isMcpBuiltInProvider,
  mcpAddServerBodySchema,
  mcpRecoveryDecisionBodySchema,
  mcpRecoveryOperationsPageQuerySchema,
} from "@alfred/contracts";
import type { McpConnection } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t, type Context } from "elysia";
import { z } from "zod";
import { consumeOAuthNonce, verifyOAuthState } from "@alfred/assistant/connections";
import {
  addUserMcpServer,
  boundedMcpErrorText,
  builtInProviderForEndpoint,
  ensureBuiltInConnection,
  getMcpConnectionManager,
  getMcpEndpointAuthorizer,
  listOwnedConnections,
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  isAddUserMcpServerRefusal,
  McpOAuthAuthorizationRequiredError,
  mcpConsentAsk,
  mcpOAuthClientConfiguration,
  mcpOAuthProviderForConnection,
  readOwnedConnection,
  updateConnection,
  withMcpEndpointAuthorization,
  type McpConnectionManager,
  type McpConnectionSummary,
  type McpEndpointAuthorizer,
  type McpEndpointConnection,
  type McpEndpointNetworkPolicy,
  type McpOAuthProviderForConnectionInput,
} from "@alfred/assistant/connections/mcp";
import {
  listMcpRecoveryOperations,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
} from "@alfred/assistant/tool-runtime/mcp";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";

const callbackParamsSchema = z.object({ state: z.string().min(1) });

const endpointAuthorizer = getMcpEndpointAuthorizer();

/** OAuth start and callback have no raw client, so they name the client's default budget. */
const OAUTH_NETWORK: McpEndpointNetworkPolicy = {
  requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS,
};

type McpOAuthCallbackProvider = Pick<
  ReturnType<typeof mcpOAuthProviderForConnection>,
  "matchesState" | "discoveryState" | "finishAuthorization"
>;

/** The connection identity plus the server definition the authorizer pins the endpoint to. */
type McpOAuthCallbackConnection = Pick<McpConnection, "id" | "userId"> & {
  readonly server: McpEndpointConnection;
};

interface McpOAuthCallbackDependencies {
  endpointAuthorizer: McpEndpointAuthorizer;
  providerForConnection(input: McpOAuthProviderForConnectionInput): McpOAuthCallbackProvider;
  connectionManager: Pick<McpConnectionManager, "getReadyClient">;
}

/** Keep one callback authorization capability alive through token exchange and reconnect. */
export async function completeMcpOAuthCallback(input: {
  connection: McpOAuthCallbackConnection;
  state: string;
  params: URLSearchParams;
  dependencies: McpOAuthCallbackDependencies;
}): Promise<void> {
  const { connection, dependencies } = input;

  return withMcpEndpointAuthorization(
    dependencies.endpointAuthorizer,
    connection.server,
    OAUTH_NETWORK,
    async (authorized) => {
      const provider = dependencies.providerForConnection({
        id: connection.id,
        userId: connection.userId,
        authorization: authorized.oauth,
      });

      if (!(await provider.matchesState(input.state))) {
        throw Errors.BadRequestError("Invalid or expired OAuth state");
      }

      if (!(await provider.discoveryState())) {
        throw Errors.BadRequestError("MCP OAuth discovery state is missing");
      }

      try {
        await provider.finishAuthorization(input.params);
        await dependencies.connectionManager.getReadyClient(connection.id);
      } catch (error) {
        await updateConnection(connection.id, {
          status: "failed",
          lastError: boundedMcpErrorText(error),
        });
        throw Errors.BadRequestError("MCP authorization callback was rejected");
      }
    },
  );
}

function connectionResult(connection: McpConnectionSummary) {
  return {
    id: connection.id,
    label: connection.label,
    canonicalResource: connection.server.canonicalResource,
    endpointOrigin: connection.server.endpointOrigin,
    // Derived from the endpoint, never stored (ADR-0093). The card picks its
    // built-in by this key; `canonicalResource.includes("github")` also matched
    // any user-added URL with the word "github" in it.
    builtInProvider: builtInProviderForEndpoint(connection.server.endpointUrl) ?? null,
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    requiredScopes: connection.requiredScopes,
    lastError: connection.lastError,
    lastConnectedAt: connection.lastConnectedAt,
    updatedAt: connection.updatedAt,
    // Null until the first catalog revision is published; the card states the
    // count only when a revision exists.
    toolCount: connection.toolCount,
  };
}

async function beginAuthorization(input: {
  connectionId: string;
  userId: string;
  forceReauthorization?: boolean;
}): Promise<URL | null> {
  const connection = await readOwnedConnection(input.connectionId, input.userId);

  if (!connection) throw Errors.NotFoundError("MCP connection not found");

  return withMcpEndpointAuthorization(
    endpointAuthorizer,
    connection.server,
    OAUTH_NETWORK,
    async (authorized) => {
      const provider = mcpOAuthProviderForConnection({
        id: connection.id,
        userId: connection.userId,
        authorization: authorized.oauth,
      });

      const consent = mcpConsentAsk(connection, {
        forced: input.forceReauthorization === true,
      });

      try {
        await provider.authorize({
          ...(consent.forceReauthorization ? { forceReauthorization: true } : {}),
          ...(consent.scope ? { scope: consent.scope } : {}),
        });

        return null;
      } catch (error) {
        if (error instanceof McpOAuthAuthorizationRequiredError) {
          await updateConnection(connection.id, {
            status: "auth_required",
            lastError: consent.pendingMessage,
          });

          return error.authorizationUrl;
        }

        // Anything else is a real failure of the authorization attempt — a server
        // that cannot register a client, an unreachable endpoint, a rejected
        // discovery document. Record it on the connection so the integrations card
        // can state the reason, instead of letting it escape as a bare 500.
        await updateConnection(connection.id, {
          status: "failed",
          lastError: boundedMcpErrorText(error),
        });
        throw error;
      }
    },
  );
}

/**
 * Both connect entrypoints and the callback are BROWSER navigations, so an
 * escaping error renders the API error page and strands the user off the
 * integrations surface. Send the browser back to the card instead. The card
 * reads `status` and `lastError` from the connection list, so the redirect
 * carries no query parameter: the durable row is the only report.
 */
function redirectToIntegrations(set: Context["set"]): null {
  set.status = 302;
  set.headers["Location"] = `${serverEnv().CORS_ORIGIN}/integrations`;

  return null;
}

/**
 * Walk one stored connection to its next consent step and answer the BROWSER.
 *
 * Every consent door ends here — the built-in connect, the generic add door's
 * `auth_required` answer, and the forced re-consent — because they differ only
 * in how they reach a connection id, never in what happens after. Two answers:
 * the authorization server wants a consent screen, so the browser goes there;
 * or the row already holds a usable credential, so the only work left is to
 * open the session.
 *
 * ONE try covers both halves on purpose. `beginAuthorization` persists every
 * reason it can name, and `getReadyClient` persists its own `failed` (or
 * `auth_required`) row with a bounded `lastError` before it rethrows, so in
 * both cases the card is where the reason is readable and the browser belongs
 * back on the integrations page. Three hand-written copies of this sequence had
 * already drifted: two of them left the session open OUTSIDE the try, so a
 * remote that went down between consent and connect answered a navigation with
 * the API error page.
 */
async function navigateToConsent(
  set: Context["set"],
  input: { connectionId: string; userId: string; forceReauthorization?: boolean },
): Promise<null> {
  try {
    const authorizationUrl = await beginAuthorization(input);

    if (authorizationUrl) {
      set.status = 302;
      set.headers["Location"] = authorizationUrl.href;

      return null;
    }

    await getMcpConnectionManager().getReadyClient(input.connectionId);
  } catch {
    return redirectToIntegrations(set);
  }

  return redirectToIntegrations(set);
}

/**
 * The MCP connection surface. Two creation doors: a first-class built-in, whose
 * endpoint the registry supplies and whose provider key the path names, and the
 * generic `POST /connections` (#1004), where the owner supplies the URL and the
 * assistant validates and probes it before any row exists.
 *
 * Both end at the SAME consent flow. `GET /connections/:id/authorize` is the
 * one door to an authorization server, so a built-in with a pinned client and a
 * pasted URL whose server registers a client dynamically differ only in where
 * the endpoint came from.
 */
export const mcpIntegrationRoutes = new Elysia({
  prefix: "/api/integrations/mcp",
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .get("/connections", async ({ user }) => {
        const connections = await listOwnedConnections(user.id);

        return { connections: connections.map((connection) => connectionResult(connection)) };
      })
      // The generic creation door (#1004). The owner supplies the endpoint; the
      // assistant validates and probes it before any row exists. A server that
      // needs sign-in answers `auth_required` with the id of the connection the
      // browser must walk to `/connections/:id/authorize`.
      .post(
        "/connections",
        async ({ body, request, user }) => {
          try {
            const result = await addUserMcpServer({
              userId: user.id,
              endpointUrl: body.endpointUrl,
              // The probe commits nothing, so a closed tab may abort it. The
              // assistant unions this with its own aggregate deadline, which is
              // what bounds a server that answers slowly but forever.
              signal: request.signal,
              ...(body.label !== undefined ? { label: body.label } : {}),
            });

            return { outcome: result.outcome, connectionId: result.connectionId };
          } catch (error) {
            // A refusal the OWNER caused is a 400, bounded by the one MCP error
            // funnel: a blocked scheme/host/port, an embedded credential, a
            // built-in's own URL, an unreachable or non-MCP endpoint. Anything
            // else — a failed insert, a missing key — is Alfred's fault and must
            // stay a 500 rather than blame the URL the owner typed.
            if (!isAddUserMcpServerRefusal(error)) throw error;

            throw Errors.BadRequestError(boundedMcpErrorText(error));
          }
        },
        { body: mcpAddServerBodySchema },
      )
      // The recovery read is pure: it never repairs a row, so a focus refetch
      // costs one query pair and no broker construction.
      .get(
        "/recovery",
        async ({ query, user }) =>
          listMcpRecoveryOperations({
            userId: user.id,
            ...(query.cursor ? { cursor: query.cursor } : {}),
          }),
        { query: mcpRecoveryOperationsPageQuerySchema },
      )
      .post(
        "/recovery/:invocationId/resolve",
        async ({ body, params, user }) =>
          resolveMcpRecoveryOperation({
            userId: user.id,
            invocationId: params.invocationId,
            decision: body.decision,
          }),
        {
          params: t.Object({ invocationId: t.String({ minLength: 1 }) }),
          // The same Zod schema the contract publishes, validated once by Elysia,
          // exactly as the GET above validates its `query`.
          body: mcpRecoveryDecisionBodySchema,
        },
      )
      // The request signal is deliberately NOT threaded into the successor send.
      // A closed tab must not abort a write that is already `delivery_possible`;
      // the broker's own request timeout is the only bound.
      .post(
        "/recovery/:invocationId/successor",
        async ({ params, user }) =>
          retryMcpRecoveryOperation({
            userId: user.id,
            invocationId: params.invocationId,
          }),
        {
          params: t.Object({ invocationId: t.String({ minLength: 1 }) }),
          body: t.Undefined(),
        },
      )
      // One door for every first-class server. The provider key is the path
      // segment, and `MCP_BUILT_IN_CATALOG` is the only thing that mints one,
      // so a fourth built-in adds no route here.
      .get(
        "/built-ins/:provider/connect",
        async ({ params, user, set }) => {
          // The segment arrives from a URL, so it is untrusted until the
          // catalog claims it. An unknown provider is a 404, not a redirect: a
          // card cannot produce one, so it is a mistyped link.
          if (!isMcpBuiltInProvider(params.provider)) {
            throw Errors.NotFoundError("Unknown built-in MCP provider");
          }

          let connectionId: string;

          try {
            // The ensure sits INSIDE the guard. It reaches the database and it
            // reconciles the pinned built-in endpoint, so it can fail on its own,
            // and a browser navigation must not meet a bare 500 page for it.
            const connection = await ensureBuiltInConnection(user.id, params.provider);

            // Drop any live client first: this door re-asks for a grant, and a
            // session opened under the old one must not survive the new ask.
            await getMcpConnectionManager().disconnect(connection.id, user.id);
            connectionId = connection.id;
          } catch {
            return redirectToIntegrations(set);
          }

          return navigateToConsent(set, { connectionId, userId: user.id });
        },
        { params: t.Object({ provider: t.String({ minLength: 1 }) }) },
      )
      // First consent for a stored connection that has never authorized — the
      // generic add door's `auth_required` answer lands here. It does NOT force
      // a consent screen: there is no grant to widen, so an authorization
      // server that can answer from an existing session should be allowed to.
      // `reconsent` below is the widening case, and it disconnects first
      // because it acts on a connection that may be live.
      .get(
        "/connections/:id/authorize",
        async ({ params, user, set }) =>
          navigateToConsent(set, { connectionId: params.id, userId: user.id }),
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
      .get(
        "/connections/:id/reconsent",
        async ({ params, user, set }) => {
          const disconnected = await getMcpConnectionManager().disconnect(params.id, user.id);

          // A 404, not a redirect: no row matches this owner and this id, so
          // there is nothing to re-consent for and no row to carry a reason.
          if (!disconnected) throw Errors.NotFoundError("MCP connection not found");

          return navigateToConsent(set, {
            connectionId: params.id,
            userId: user.id,
            forceReauthorization: true,
          });
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
      // Generic lifecycle actions (#1004). Reconnect drops the live client and
      // opens a fresh generation; disconnect closes it and marks the row.
      .post(
        "/connections/:id/reconnect",
        async ({ params, user }) => {
          let reconnected: boolean;

          try {
            // The manager owns the close/open pair because it owns the restore:
            // a remote that is down between the two must not cost the row its
            // published catalog.
            reconnected = await getMcpConnectionManager().reconnect(params.id, user.id);
          } catch (error) {
            throw Errors.BadRequestError(boundedMcpErrorText(error));
          }

          if (!reconnected) throw Errors.NotFoundError("MCP connection not found");

          return { status: "connected" as const };
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
      .post(
        "/connections/:id/disconnect",
        async ({ params, user }) => {
          const disconnected = await getMcpConnectionManager().disconnect(params.id, user.id);

          if (!disconnected) throw Errors.NotFoundError("MCP connection not found");

          return { status: "disconnected" as const };
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      ),
  )
  .get("/client-metadata", () => mcpOAuthClientConfiguration().clientMetadata)
  .get("/callback", async ({ request, set }) => {
    const params = new URL(request.url).searchParams;
    const parsed = callbackParamsSchema.safeParse({ state: params.get("state") });

    if (!parsed.success) throw Errors.BadRequestError("Missing or invalid OAuth state");
    const decoded = verifyOAuthState(parsed.data.state);

    if (!decoded?.connectionId) throw Errors.BadRequestError("Invalid OAuth state");
    const storedUserId = await consumeOAuthNonce(`mcp:${decoded.connectionId}`, decoded.nonce);

    if (!storedUserId || storedUserId !== decoded.userId) {
      throw Errors.BadRequestError("Invalid or expired OAuth state");
    }

    const connection = await readOwnedConnection(decoded.connectionId, decoded.userId);

    if (!connection) throw Errors.BadRequestError("MCP connection no longer exists");
    await completeMcpOAuthCallback({
      connection,
      state: parsed.data.state,
      params,
      dependencies: {
        endpointAuthorizer,
        providerForConnection: mcpOAuthProviderForConnection,
        // The URLSearchParams overload validates `iss` before it reads any
        // callback error text or redeems the authorization code.
        connectionManager: getMcpConnectionManager(),
      },
    });

    return redirectToIntegrations(set);
  });
