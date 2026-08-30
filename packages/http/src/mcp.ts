import { Errors, mcpRecoveryDecisionSchema } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t } from "elysia";
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
    throw error;
  }
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
      .get("/recovery", async ({ user }) => ({
        operations: await listMcpRecoveryOperations(user.id),
      }))
      .post(
        "/recovery/:invocationId/resolve",
        async ({ body, params, user }) => {
          const decision = mcpRecoveryDecisionSchema.safeParse(body.decision);
          if (!decision.success) throw Errors.BadRequestError("Invalid MCP recovery decision");
          return resolveMcpRecoveryOperation({
            userId: user.id,
            invocationId: params.invocationId,
            decision: decision.data,
          });
        },
        {
          params: t.Object({ invocationId: t.String({ minLength: 1 }) }),
          body: t.Object(
            {
              decision: t.String(),
            },
            { additionalProperties: false },
          ),
        },
      )
      .post(
        "/recovery/:invocationId/successor",
        async ({ params, request, user }) =>
          retryMcpRecoveryOperation({
            userId: user.id,
            invocationId: params.invocationId,
            signal: request.signal,
          }),
        {
          params: t.Object({ invocationId: t.String({ minLength: 1 }) }),
          body: t.Undefined(),
        },
      )
      .get("/github/connect", async ({ user, set }) => {
        const connection = await ensureBuiltInConnection(user.id, "github");
        await getMcpConnectionManager().disconnect(connection.id, user.id);
        const authorizationUrl = await beginAuthorization({
          connectionId: connection.id,
          userId: user.id,
        });
        if (authorizationUrl) {
          set.status = 302;
          set.headers["Location"] = authorizationUrl.href;
          return null;
        }
        await getMcpConnectionManager().getReadyClient(connection.id);
        set.status = 302;
        set.headers["Location"] = `${serverEnv().CORS_ORIGIN}/integrations?mcp_connected=github`;
        return null;
      })
      .get(
        "/connections/:id/reconsent",
        async ({ params, user, set }) => {
          const disconnected = await getMcpConnectionManager().disconnect(params.id, user.id);
          if (!disconnected) throw Errors.NotFoundError("MCP connection not found");
          const authorizationUrl = await beginAuthorization({
            connectionId: params.id,
            userId: user.id,
            forceReauthorization: true,
          });
          if (authorizationUrl) {
            set.status = 302;
            set.headers["Location"] = authorizationUrl.href;
            return null;
          }
          await getMcpConnectionManager().getReadyClient(params.id);
          set.status = 302;
          set.headers["Location"] = `${serverEnv().CORS_ORIGIN}/integrations?mcp_connected=1`;
          return null;
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
    set.status = 302;
    set.headers["Location"] =
      `${serverEnv().CORS_ORIGIN}/integrations?mcp_connected=${encodeURIComponent(connection.label)}`;
    return null;
  });
