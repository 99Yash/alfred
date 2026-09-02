import {
  Errors,
  mcpRecoveryDecisionBodySchema,
  mcpRecoveryOperationsPageQuerySchema,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t, type Context } from "elysia";
import { z } from "zod";
import { consumeOAuthNonce, verifyOAuthState } from "@alfred/assistant/connections";
import {
  authorizeMcpOAuth,
  boundedMcpErrorText,
  ensureBuiltInConnection,
  finishMcpOAuth,
  getMcpConnectionManager,
  listOwnedConnections,
  McpOAuthAuthorizationRequiredError,
  mcpOAuthClientConfiguration,
  mcpOAuthProviderForConnection,
  readOwnedConnection,
  updateConnection,
} from "@alfred/assistant/connections/mcp";
import {
  listMcpRecoveryOperations,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
} from "@alfred/assistant/tool-runtime/mcp";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";

const callbackParamsSchema = z.object({ state: z.string().min(1) });

function connectionResult(
  connection: NonNullable<Awaited<ReturnType<typeof readOwnedConnection>>>,
) {
  return {
    id: connection.id,
    label: connection.label,
    canonicalResource: connection.server.canonicalResource,
    endpointOrigin: connection.server.endpointOrigin,
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    requiredScopes: connection.requiredScopes,
    lastError: connection.lastError,
    lastConnectedAt: connection.lastConnectedAt,
    updatedAt: connection.updatedAt,
  };
}

async function beginAuthorization(input: {
  connectionId: string;
  userId: string;
  forceReauthorization?: boolean;
}): Promise<URL | null> {
  const connection = await readOwnedConnection(input.connectionId, input.userId);
  if (!connection) throw Errors.NotFoundError("MCP connection not found");
  const provider = mcpOAuthProviderForConnection({
    connectionId: connection.id,
    userId: connection.userId,
    endpoint: new URL(connection.server.endpointUrl),
  });
  const scope = [...new Set([...connection.grantedScopes, ...connection.requiredScopes])].join(" ");
  try {
    await authorizeMcpOAuth(provider, new URL(connection.server.endpointUrl), {
      ...(input.forceReauthorization ? { forceReauthorization: true } : {}),
      ...(scope ? { scope } : {}),
    });
    return null;
  } catch (error) {
    if (error instanceof McpOAuthAuthorizationRequiredError) {
      await updateConnection(connection.id, {
        status: "auth_required",
        lastError: input.forceReauthorization
          ? "Additional permissions require your consent."
          : "Authorization is required to connect this MCP server.",
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
 * First real MCP connection surface. The endpoint is fixed to GitHub until the
 * separate endpoint-authorizer slice admits arbitrary URLs.
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
    const provider = mcpOAuthProviderForConnection({
      connectionId: connection.id,
      userId: connection.userId,
      endpoint: new URL(connection.server.endpointUrl),
    });
    if (!(await provider.matchesState(parsed.data.state))) {
      throw Errors.BadRequestError("Invalid or expired OAuth state");
    }
    if (!(await provider.discoveryState())) {
      throw Errors.BadRequestError("MCP OAuth discovery state is missing");
    }
    try {
      // The URLSearchParams overload validates `iss` before it reads any
      // callback error text or redeems the authorization code.
      await finishMcpOAuth(provider, new URL(connection.server.endpointUrl), params);
      await getMcpConnectionManager().getReadyClient(connection.id);
    } catch (error) {
      await updateConnection(connection.id, {
        status: "failed",
        lastError: boundedMcpErrorText(error),
      });
      throw Errors.BadRequestError("MCP authorization callback was rejected");
    }
    return redirectToIntegrations(set);
  });
