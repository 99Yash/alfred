import { Errors } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t } from "elysia";
import { z } from "zod";
import { authMacro } from "../../../middleware/auth";
import { consumeOAuthNonce, verifyOAuthState } from "../oauth-state";
import { boundedMcpErrorText } from "./errors";
import { MCP_OAUTH_PENDING_ISSUER } from "./manager";
import {
  authorizeMcpOAuth,
  finishMcpOAuth,
  McpOAuthAuthorizationRequiredError,
  mcpOAuthClientConfiguration,
  mcpOAuthProviderForConnection,
} from "./oauth";
import {
  listOwnedConnections,
  readOwnedConnection,
  updateConnection,
  upsertConnection,
} from "./persistence";
import { getMcpConnectionManager } from "./runtime";

const GITHUB_MCP_ENDPOINT = new URL("https://api.githubcopilot.com/mcp");
const callbackParamsSchema = z.object({ state: z.string().min(1) });

function connectionResult(
  connection: NonNullable<Awaited<ReturnType<typeof readOwnedConnection>>>,
) {
  return {
    id: connection.id,
    label: connection.label,
    canonicalResource: connection.canonicalResource,
    endpointOrigin: connection.endpointOrigin,
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
    endpoint: new URL(connection.endpointUrl),
  });
  const scope = [...new Set([...connection.grantedScopes, ...connection.requiredScopes])].join(" ");
  try {
    await authorizeMcpOAuth(provider, new URL(connection.endpointUrl), {
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
  .guard({ auth: true }, (app) =>
    app
      .get("/connections", async ({ user }) => {
        const connections = await listOwnedConnections(user.id);
        return { connections: connections.map((connection) => connectionResult(connection)) };
      })
      .get("/github/connect", async ({ user, set }) => {
        const connection = await upsertConnection({
          userId: user.id,
          label: "GitHub MCP",
          canonicalResource: GITHUB_MCP_ENDPOINT.href,
          endpointUrl: GITHUB_MCP_ENDPOINT.href,
          endpointOrigin: GITHUB_MCP_ENDPOINT.origin,
          authServerIdentity: MCP_OAUTH_PENDING_ISSUER,
          status: "disconnected",
        });
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
      endpoint: new URL(connection.endpointUrl),
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
      await finishMcpOAuth(provider, new URL(connection.endpointUrl), params);
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
