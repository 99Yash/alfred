import {
  Errors,
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
 * The MCP connection surface. Two creation doors: the GitHub built-in, whose
 * endpoint the registry supplies, and the generic `POST /connections` (#1004),
 * where the owner supplies the URL and the assistant validates and probes it
 * before any row exists.
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
      // First generic creation door (#1004). The owner supplies the endpoint;
      // the assistant validates and probes it before any row exists, so a
      // server that needs sign-in creates nothing and reports `auth_required`.
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

            return { outcome: result.outcome };
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
      .get("/github/connect", async ({ user, set }) => {
        let authorizationUrl: URL | null;

        try {
          // The ensure sits INSIDE the guard. It reaches the database and it
          // reconciles the pinned built-in endpoint, so it can fail on its own,
          // and a browser navigation must not meet a bare 500 page for it.
          const connection = await ensureBuiltInConnection(user.id, "github");
          await getMcpConnectionManager().disconnect(connection.id, user.id);
          authorizationUrl = await beginAuthorization({
            connectionId: connection.id,
            userId: user.id,
          });

          if (!authorizationUrl) await getMcpConnectionManager().getReadyClient(connection.id);
        } catch {
          // `beginAuthorization` already persisted every reason it can name.
          return redirectToIntegrations(set);
        }

        if (authorizationUrl) {
          set.status = 302;
          set.headers["Location"] = authorizationUrl.href;

          return null;
        }

        return redirectToIntegrations(set);
      })
      .get(
        "/connections/:id/reconsent",
        async ({ params, user, set }) => {
          const disconnected = await getMcpConnectionManager().disconnect(params.id, user.id);

          if (!disconnected) throw Errors.NotFoundError("MCP connection not found");
          let authorizationUrl: URL | null;

          try {
            authorizationUrl = await beginAuthorization({
              connectionId: params.id,
              userId: user.id,
              forceReauthorization: true,
            });
          } catch {
            // `beginAuthorization` already persisted every reason it can name.
            return redirectToIntegrations(set);
          }

          if (authorizationUrl) {
            set.status = 302;
            set.headers["Location"] = authorizationUrl.href;

            return null;
          }

          await getMcpConnectionManager().getReadyClient(params.id);

          return redirectToIntegrations(set);
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
