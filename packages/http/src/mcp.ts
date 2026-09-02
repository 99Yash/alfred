import { Errors } from "@alfred/contracts";
import type { McpConnection } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t } from "elysia";
import { z } from "zod";
import { consumeOAuthNonce, verifyOAuthState } from "@alfred/assistant/connections";
import {
  boundedMcpErrorText,
  getMcpConnectionManager,
  HostedMcpEndpointAuthorizer,
  listOwnedConnections,
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  MCP_OAUTH_PENDING_ISSUER,
  McpOAuthAuthorizationRequiredError,
  mcpOAuthClientConfiguration,
  mcpOAuthProviderForConnection,
  readOwnedConnection,
  updateConnection,
  upsertConnection,
  withMcpEndpointAuthorization,
  type McpConnectionManager,
  type McpEndpointAuthorizer,
  type McpEndpointNetworkPolicy,
  type McpOAuthProviderForConnectionInput,
} from "@alfred/assistant/connections/mcp";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";

const GITHUB_MCP_ENDPOINT = new URL("https://api.githubcopilot.com/mcp");
const callbackParamsSchema = z.object({ state: z.string().min(1) });
const endpointAuthorizer = new HostedMcpEndpointAuthorizer();
/** OAuth start and callback have no raw client, so they name the client's default budget. */
const OAUTH_NETWORK: McpEndpointNetworkPolicy = {
  requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS,
};

type McpOAuthCallbackProvider = Pick<
  ReturnType<typeof mcpOAuthProviderForConnection>,
  "matchesState" | "discoveryState" | "finishAuthorization"
>;
type McpOAuthCallbackConnection = Pick<
  McpConnection,
  "id" | "userId" | "endpointUrl" | "endpointOrigin"
>;

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
    connection,
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
  return withMcpEndpointAuthorization(
    endpointAuthorizer,
    connection,
    OAUTH_NETWORK,
    async (authorized) => {
      const provider = mcpOAuthProviderForConnection({
        id: connection.id,
        userId: connection.userId,
        authorization: authorized.oauth,
      });
      const scope = [...new Set([...connection.grantedScopes, ...connection.requiredScopes])].join(
        " ",
      );
      try {
        await provider.authorize({
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
    },
  );
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
    set.status = 302;
    set.headers["Location"] =
      `${serverEnv().CORS_ORIGIN}/integrations?mcp_connected=${encodeURIComponent(connection.label)}`;
    return null;
  });
