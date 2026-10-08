import {
  Errors,
  isApiError,
  isBuiltInMCPProvider,
  mcpAddServerBodySchema,
  mcpExternalToolRefSchema,
  mcpHealthMappingReviewInputSchema,
  mcpHealthMappingStateSchema,
  mcpRecoveryDecisionBodySchema,
  mcpRecoveryOperationsPageQuerySchema,
  mcpRenameConnectionBodySchema,
  mcpToolDiscoveryPageSchema,
  mcpToolInspectionResultSchema,
  mcpToolInspectInputSchema,
  mcpToolPolicyReviewInputSchema,
  mcpToolPolicyStateSchema,
  mcpToolSearchInputSchema,
  type ExternalToolRef,
  type McpHealthMappingState as McpHealthMappingWireState,
  type McpToolPolicy,
  type McpToolPolicyState,
} from "@alfred/contracts";
import type { McpConnection, McpToolPolicyRow } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t, type Context } from "elysia";
import { z } from "zod";
import { consumeOAuthNonce, verifyOAuthState } from "@alfred/assistant/connections";
import {
  addUserMcpServer,
  boundedMcpErrorText,
  builtInOAuthPolicyForEndpoint,
  builtInProviderForEndpoint,
  ensureBuiltInConnection,
  getMcpConnectionManager,
  getMcpEndpointAuthorizer,
  listMcpToolsLocal,
  listOwnedConnections,
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  isAddUserMcpServerRefusal,
  isMcpAuthorizationChallenge,
  isMcpTransportFailure,
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
  clearMcpHealthMapping,
  clearMcpToolPolicy,
  listMcpRecoveryOperations,
  mcpUnresolvedInvocationGate,
  readMcpHealthMappingState,
  readMcpToolPolicyState,
  resolveMcpRecoveryOperation,
  retryMcpRecoveryOperation,
  reviewMcpHealthMapping,
  reviewMcpToolPolicy,
} from "@alfred/assistant/tool-runtime/mcp";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";

const callbackParamsSchema = z.object({ state: z.string().min(1) });

const endpointAuthorizer = getMcpEndpointAuthorizer();

/** OAuth has no raw client, so it uses the client's default timeout. */
const OAUTH_NETWORK: McpEndpointNetworkPolicy = {
  requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS,
};

type McpOAuthCallbackProvider = Pick<
  ReturnType<typeof mcpOAuthProviderForConnection>,
  "matchesState" | "discoveryState" | "finishAuthorization"
>;

type McpOAuthCallbackConnection = Pick<McpConnection, "id" | "userId"> & {
  readonly server: McpEndpointConnection;
};

interface McpOAuthCallbackDependencies {
  endpointAuthorizer: McpEndpointAuthorizer;
  providerForConnection(input: McpOAuthProviderForConnectionInput): McpOAuthCallbackProvider;
  connectionManager: Pick<McpConnectionManager, "getReadyClient">;
}

/** The one callback phase where a transport failure can recover with stored tokens. */
class McpPostConsentHandshakeError extends Error {
  constructor(cause: unknown) {
    super("MCP connection handshake failed", { cause });
    this.name = "McpPostConsentHandshakeError";
  }
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
    builtInOAuthPolicyForEndpoint(connection.server.endpointUrl),
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

      await provider.finishAuthorization(input.params);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          // Writes status only when it opens a new client; each consent door drops the old one first.
          await dependencies.connectionManager.getReadyClient(connection.id);

          return;
        } catch (error) {
          if (!isMcpTransportFailure(error) || attempt === 3) {
            throw new McpPostConsentHandshakeError(error);
          }

          await updateConnection(connection.id, { status: "connecting", lastError: null });
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
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
    // Derived from the endpoint, never stored (ADR-0093).
    builtInProvider: builtInProviderForEndpoint(connection.server.endpointUrl) ?? null,
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    requiredScopes: connection.requiredScopes,
    lastError: connection.lastError,
    lastConnectedAt: connection.lastConnectedAt,
    updatedAt: connection.updatedAt,
    // Null until the first catalog revision exists.
    toolCount: connection.toolCount,
  };
}

/** Only browser-visible fields cross. The caller's contract parse validates the enum columns. */
function mcpToolPolicyResult(policy: McpToolPolicyRow): McpToolPolicy {
  return {
    riskTier: policy.riskTier,
    effectClass: policy.effectClass,
    retryContract: policy.retryContract,
    note: policy.reviewedNote,
    policyRevision: policy.policyRevision,
    reviewedAt: policy.reviewedAt?.toISOString() ?? null,
  };
}

/** Only a missing connection is a 404. `not_found` and `catalog_stale` are typed 200 bodies. */
function mcpToolPolicyStateResult(
  state: Awaited<ReturnType<typeof readMcpToolPolicyState>>,
  ref: ExternalToolRef,
): McpToolPolicyState {
  switch (state.status) {
    case "reviewed":
      return mcpToolPolicyStateSchema.parse({
        status: "reviewed",
        ref,
        policy: mcpToolPolicyResult(state.policy),
      });
    case "drifted":
      return mcpToolPolicyStateSchema.parse({
        status: "drifted",
        ref,
        previous: mcpToolPolicyResult(state.previous),
      });
    case "unreviewed":
      return mcpToolPolicyStateSchema.parse({ status: "unreviewed", ref });
    case "catalog_stale":
      return mcpToolPolicyStateSchema.parse({ status: "catalog_stale", ref });
    case "not_found":
      return mcpToolPolicyStateSchema.parse({ status: "not_found", ref });
    case "connection_missing":
      throw Errors.NotFoundError("MCP connection not found");
  }
}

function mcpHealthMappingStateResult(
  state: Awaited<ReturnType<typeof readMcpHealthMappingState>>,
  ref: ExternalToolRef,
): McpHealthMappingWireState {
  switch (state.status) {
    case "reviewed":
      return mcpHealthMappingStateSchema.parse({ status: "reviewed", ref, mapping: state.mapping });
    case "drifted":
      return mcpHealthMappingStateSchema.parse({
        status: "drifted",
        ref,
        previous: state.previous,
      });
    case "invalid":
      return mcpHealthMappingStateSchema.parse({ status: "invalid", ref });
    case "unreviewed":
      return mcpHealthMappingStateSchema.parse({ status: "unreviewed", ref });
    case "catalog_stale":
      return mcpHealthMappingStateSchema.parse({ status: "catalog_stale", ref });
    case "not_found":
      return mcpHealthMappingStateSchema.parse({ status: "not_found", ref });
    case "not_read_only":
      return mcpHealthMappingStateSchema.parse({ status: "not_read_only", ref });
    case "connection_missing":
      throw Errors.NotFoundError("MCP connection not found");
  }
}

async function beginAuthorization(input: {
  connectionId: string;
  userId: string;
  forceReauthorization?: boolean;
}): Promise<URL | null> {
  const connection = await readOwnedConnection(input.connectionId, input.userId);

  if (!connection) throw Errors.NotFoundError("MCP connection not found");
  const consent = mcpConsentAsk(connection, { forced: input.forceReauthorization === true });

  try {
    return await withMcpEndpointAuthorization(
      endpointAuthorizer,
      connection.server,
      OAUTH_NETWORK,
      builtInOAuthPolicyForEndpoint(connection.server.endpointUrl),
      async (authorized) => {
        const provider = mcpOAuthProviderForConnection({
          id: connection.id,
          userId: connection.userId,
          authorization: authorized.oauth,
        });

        await provider.authorize({
          ...(consent.forceReauthorization ? { forceReauthorization: true } : {}),
          ...(consent.scope ? { scope: consent.scope } : {}),
        });

        return null;
      },
    );
  } catch (error) {
    // The SDK throws to ask for a consent screen. That is the normal path.
    if (error instanceof McpOAuthAuthorizationRequiredError) {
      await updateConnection(connection.id, {
        status: "auth_required",
        lastError: consent.pendingMessage,
      });

      return error.authorizationUrl;
    }

    // Record it here, not in the callback: the authorizer can refuse before the callback runs.
    await updateConnection(connection.id, {
      status: "failed",
      lastError: boundedMcpErrorText(error),
    });
    throw error;
  }
}

/** These are browser navigations, so send errors back to the card. The row carries the reason. */
function redirectToIntegrations(set: Context["set"]): null {
  set.status = 302;
  set.headers["Location"] = `${serverEnv().CORS_ORIGIN}/integrations`;

  return null;
}

/**
 * Every consent door ends here: redirect to the consent screen, or open the client.
 * One try covers both, because each half writes its failure to the row first.
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
  } catch (error) {
    // A missing row has no card to show the reason, so it stays a 404.
    if (isApiError(error, "NOT_FOUND")) throw error;

    return redirectToIntegrations(set);
  }

  return redirectToIntegrations(set);
}

/** MCP connections: built-ins and owner-added URLs share one consent flow. */
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
      // Add a server by URL. `auth_required` returns the id to send to `/connections/:id/authorize`.
      .post(
        "/connections",
        async ({ body, request, user }) => {
          try {
            const result = await addUserMcpServer({
              userId: user.id,
              endpointUrl: body.endpointUrl,
              // The probe writes nothing, so a closed tab may abort it.
              signal: request.signal,
              ...(body.label !== undefined ? { label: body.label } : {}),
              ...(body.auth !== undefined ? { auth: body.auth } : {}),
            });

            return { outcome: result.outcome, connectionId: result.connectionId };
          } catch (error) {
            // A bad URL is a 400. Our own failures stay a 500.
            if (!isAddUserMcpServerRefusal(error)) throw error;

            throw Errors.BadRequestError(boundedMcpErrorText(error));
          }
        },
        { body: mcpAddServerBodySchema },
      )
      // Read only: it never repairs a row.
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
          body: mcpRecoveryDecisionBodySchema,
        },
      )
      // No request signal: a closed tab must not abort a write that may already be delivered.
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
      // One route for every built-in in `BUILT_IN_MCP_CATALOG`.
      .get(
        "/built-ins/:provider/connect",
        async ({ params, user, set }) => {
          // A card cannot produce an unknown provider, so it is a 404, not a redirect.
          if (!isBuiltInMCPProvider(params.provider)) {
            throw Errors.NotFoundError("Unknown built-in MCP provider");
          }

          let connectionId: string;

          try {
            // Inside the try: it can fail, and a navigation must not show a 500 page.
            const connection = await ensureBuiltInConnection(user.id, params.provider);

            // A session from the old grant must not outlive the new ask.
            await getMcpConnectionManager().disconnect(connection.id, user.id);
            connectionId = connection.id;
          } catch {
            return redirectToIntegrations(set);
          }

          return navigateToConsent(set, { connectionId, userId: user.id });
        },
        { params: t.Object({ provider: t.String({ minLength: 1 }) }) },
      )
      // Consent for a stored connection. It does not force a consent screen; `reconsent` does.
      // It must drop the live client: with a cached client, the callback writes no status,
      // and the row stays stuck in `auth_required`.
      .get(
        "/connections/:id/authorize",
        async ({ params, user, set }) => {
          await getMcpConnectionManager().disconnect(params.id, user.id);

          return navigateToConsent(set, { connectionId: params.id, userId: user.id });
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
      .get(
        "/connections/:id/reconsent",
        async ({ params, user, set }) => {
          const disconnected = await getMcpConnectionManager().disconnect(params.id, user.id);

          if (!disconnected) throw Errors.NotFoundError("MCP connection not found");

          return navigateToConsent(set, {
            connectionId: params.id,
            userId: user.id,
            forceReauthorization: true,
          });
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
      .post(
        "/connections/:id/reconnect",
        async ({ params, user }) => {
          let reconnected: boolean;

          try {
            // The manager keeps the published catalog if the remote is down between close and open.
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
      )
      // A built-in is a 400: its label resets on the next connect.
      .patch(
        "/connections/:id",
        async ({ body, params, user }) => {
          const renamed = await getMcpConnectionManager().rename(params.id, user.id, body.label);

          if (renamed.outcome === "built_in") {
            throw Errors.BadRequestError("A built-in MCP connection cannot be renamed");
          }

          if (renamed.outcome === "not_found") {
            throw Errors.NotFoundError("MCP connection not found");
          }

          return { id: renamed.id, label: renamed.label };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: mcpRenameConnectionBodySchema,
        },
      )
      // Refused while an invocation is unresolved: resolve it first, then remove.
      .delete(
        "/connections/:id",
        async ({ params, user }) => {
          const outcome = await getMcpConnectionManager().remove(
            params.id,
            user.id,
            mcpUnresolvedInvocationGate,
          );

          if (outcome === "blocked") {
            throw Errors.ConflictError(
              "Resolve the pending MCP operation before removing this connection",
            );
          }

          if (outcome === "not_found") {
            throw Errors.NotFoundError("MCP connection not found");
          }

          return { id: params.id, ok: true as const };
        },
        { params: t.Object({ id: t.String({ minLength: 1 }) }) },
      )
      // Reads the stored catalog only; never dials the remote. The query omits `connectionId`,
      // so the path is the only connection a client can name.
      .get(
        "/connections/:id/tools",
        async ({ params, query, user }) => {
          const page = await listMcpToolsLocal({
            userId: user.id,
            request: { ...query, connectionId: params.id },
          });

          return mcpToolDiscoveryPageSchema.parse(page);
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          query: mcpToolSearchInputSchema.omit({ connectionId: true, namespace: true }),
        },
      )
      // A stale `catalogRevision` answers `catalog_stale` (ADR-0094).
      .get(
        "/connections/:id/tools/inspect",
        async ({ params, query, user }) => {
          const result = await listMcpToolsLocal({
            userId: user.id,
            request: {
              ref: {
                kind: "mcp",
                connectionId: params.id,
                remoteName: query.remoteName,
                catalogRevision: query.catalogRevision,
              },
            },
          });

          return mcpToolInspectionResultSchema.parse(result);
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          query: mcpExternalToolRefSchema.pick({ remoteName: true, catalogRevision: true }),
        },
      )
      // Policy review (ADR-0088 / ADR-0096). `ref.connectionId` always comes from the path.
      .get(
        "/connections/:id/tools/policy",
        async ({ params, query, user }) => {
          const ref: ExternalToolRef = {
            kind: "mcp",
            connectionId: params.id,
            remoteName: query.remoteName,
            catalogRevision: query.catalogRevision,
          };

          return mcpToolPolicyStateResult(
            await readMcpToolPolicyState({ userId: user.id, ref }),
            ref,
          );
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          query: mcpExternalToolRefSchema.pick({ remoteName: true, catalogRevision: true }),
        },
      )
      .put(
        "/connections/:id/tools/policy",
        async ({ body, params, user }) => {
          if (body.ref.connectionId !== params.id) {
            throw Errors.BadRequestError("MCP tool reference must name the path connection");
          }

          const state = await reviewMcpToolPolicy({
            userId: user.id,
            ref: body.ref,
            riskTier: body.riskTier,
            effectClass: body.effectClass,
            retryContract: body.retryContract,
            note: body.note,
          });

          if (state.status === "catalog_stale") {
            throw Errors.ConflictError(
              "The MCP catalog changed; refresh and review the tool again",
            );
          }

          if (state.status === "not_found") {
            throw Errors.NotFoundError("MCP tool not found in the current catalog");
          }

          return mcpToolPolicyStateResult(state, body.ref);
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: mcpToolPolicyReviewInputSchema,
        },
      )
      .delete(
        "/connections/:id/tools/policy",
        async ({ body, params, user }) => {
          if (body.ref.connectionId !== params.id) {
            throw Errors.BadRequestError("MCP tool reference must name the path connection");
          }

          const state = await clearMcpToolPolicy({ userId: user.id, ref: body.ref });

          if (state.status === "catalog_stale") {
            throw Errors.ConflictError(
              "The MCP catalog changed; refresh and clear the review again",
            );
          }

          if (state.status === "not_found") {
            throw Errors.NotFoundError("MCP tool not found in the current catalog");
          }

          return mcpToolPolicyStateResult(state, body.ref);
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: mcpToolInspectInputSchema,
        },
      )
      // Health mapping. Same server-derived hash and revision lock as policy review.
      .get(
        "/connections/:id/tools/health-mapping",
        async ({ params, query, user }) => {
          const ref: ExternalToolRef = {
            kind: "mcp",
            connectionId: params.id,
            remoteName: query.remoteName,
            catalogRevision: query.catalogRevision,
          };

          return mcpHealthMappingStateResult(
            await readMcpHealthMappingState({ userId: user.id, ref }),
            ref,
          );
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          query: mcpExternalToolRefSchema.pick({ remoteName: true, catalogRevision: true }),
        },
      )
      .put(
        "/connections/:id/tools/health-mapping",
        async ({ body, params, user }) => {
          if (body.ref.connectionId !== params.id) {
            throw Errors.BadRequestError("MCP tool reference must name the path connection");
          }

          const state = await reviewMcpHealthMapping({
            userId: user.id,
            ref: body.ref,
            readOnly: body.readOnly,
            definition: body.definition,
            note: body.note,
          });

          if (state.status === "catalog_stale") {
            throw Errors.ConflictError(
              "The MCP catalog changed; refresh and review the health mapping again",
            );
          }

          if (state.status === "not_found") {
            throw Errors.NotFoundError("MCP tool not found in the current catalog");
          }

          if (state.status === "not_read_only") {
            throw Errors.BadRequestError("MCP health mappings require a read-only descriptor");
          }

          return mcpHealthMappingStateResult(state, body.ref);
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: mcpHealthMappingReviewInputSchema,
        },
      )
      .delete(
        "/connections/:id/tools/health-mapping",
        async ({ body, params, user }) => {
          if (body.ref.connectionId !== params.id) {
            throw Errors.BadRequestError("MCP tool reference must name the path connection");
          }

          const state = await clearMcpHealthMapping({ userId: user.id, ref: body.ref });

          if (state.status === "catalog_stale") {
            throw Errors.ConflictError(
              "The MCP catalog changed; refresh and clear the health mapping again",
            );
          }

          if (state.status === "not_found") {
            throw Errors.NotFoundError("MCP tool not found in the current catalog");
          }

          return mcpHealthMappingStateResult(state, body.ref);
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: mcpToolInspectInputSchema,
        },
      ),
  )
  // The Client ID Metadata Document, not the RFC 7591 body. There is none on an `http://` base.
  .get("/client-metadata", () => {
    const { clientMetadataDocument } = mcpOAuthClientConfiguration();

    if (!clientMetadataDocument) {
      throw Errors.NotFoundError("MCP client metadata is served over HTTPS only");
    }

    return clientMetadataDocument;
  })
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

    try {
      await completeMcpOAuthCallback({
        connection,
        state: parsed.data.state,
        // URLSearchParams lets the SDK validate `iss` before it reads errors or redeems the code.
        params,
        dependencies: {
          endpointAuthorizer,
          providerForConnection: mcpOAuthProviderForConnection,
          connectionManager: getMcpConnectionManager(),
        },
      });
    } catch (error) {
      if (
        !(error instanceof McpOAuthAuthorizationRequiredError) &&
        !(error instanceof McpPostConsentHandshakeError && isMcpAuthorizationChallenge(error))
      ) {
        await updateConnection(connection.id, {
          status:
            error instanceof McpPostConsentHandshakeError && isMcpTransportFailure(error)
              ? "connecting"
              : "failed",
          lastError: boundedMcpErrorText(error),
        });
      }
    }

    return redirectToIntegrations(set);
  });
