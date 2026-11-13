/**
 * The GitHub App install connects the GitHub MCP too (ADR-0093 amendment 2026-11-12).
 * The built-in uses the App's own OAuth client, so the user token from the install is a
 * valid grant for the MCP endpoint. The MCP row becomes the only holder that refreshes it:
 * GitHub rotates the refresh token on each use.
 */

import { assertNever } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import type { ExchangeUserCodeResult } from "@alfred/integrations/github";
import { logger } from "@alfred/logging";

import { BUILT_IN_REGISTRY, builtInProviderForEndpoint } from "./built-ins";
import { MCP_DEFAULT_REQUEST_TIMEOUT_MS } from "./client";
import { getMcpEndpointAuthorizer, withMcpEndpointAuthorization } from "./endpoint-authorization";
import { boundedMcpErrorText } from "./errors";
import { clearMcpOAuthGrant, mcpOAuthProviderForConnection } from "./oauth";
import { ensureBuiltInConnection, listOwnedConnections } from "./persistence";
import { getMcpConnectionManager } from "./runtime";

/** The grant half of the App's token response. `exchangeUserCode` owns the shape. */
export type GithubAppUserGrant = Pick<
  ExchangeUserCodeResult,
  "accessToken" | "refreshToken" | "tokenType" | "expiresInSeconds" | "scopes"
>;

/**
 * What the App grant did for the GitHub MCP. The callback puts a code other than `connected` on
 * its redirect, so the page tells the owner. The row holds the detail, except when the row
 * itself could not be created.
 */
export type GithubAppGrantOutcome =
  | { readonly outcome: "connected" }
  | { readonly outcome: "auth_required" }
  | { readonly outcome: "failed"; readonly message: string };

/**
 * Store `grant` on the user's GitHub MCP connection and open the client. It never throws: the
 * outcome names a failure, and the manager also writes it to the row.
 */
export async function adoptGithubAppGrant(input: {
  readonly userId: string;
  readonly grant: GithubAppUserGrant;
}): Promise<GithubAppGrantOutcome> {
  let connectionId: string | undefined;

  try {
    const connection = await ensureBuiltInConnection(input.userId, "github");
    connectionId = connection.id;

    const adopted = await getMcpConnectionManager().adoptGrant(connection.id, input.userId, () =>
      withMcpEndpointAuthorization(
        getMcpEndpointAuthorizer(),
        connection.server,
        { requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS },
        (authorized) =>
          mcpOAuthProviderForConnection({
            id: connection.id,
            userId: input.userId,
            authorization: authorized.oauth,
          }).adoptGrant({
            // The registry declares the client once. The grant must come from that client.
            clientId: serverEnv()[BUILT_IN_REGISTRY.github.staticClient.clientIdKey],
            tokens: {
              access_token: input.grant.accessToken,
              token_type: input.grant.tokenType,
              ...(input.grant.refreshToken ? { refresh_token: input.grant.refreshToken } : {}),
              ...(input.grant.expiresInSeconds === null
                ? {}
                : { expires_in: input.grant.expiresInSeconds }),
              scope: input.grant.scopes.join(" "),
            },
          }),
      ),
    );

    switch (adopted.outcome) {
      case "connected":
      case "auth_required":
        return { outcome: adopted.outcome };
      case "not_found":
        return { outcome: "failed", message: "The GitHub connection row is missing." };
      case "failed":
        logger.warn(
          { event: "github_app_mcp_grant_failed", connectionId, lastError: adopted.lastError },
          "The GitHub App connect could not open the GitHub MCP",
        );

        return { outcome: "failed", message: adopted.lastError };
      default:
        return assertNever(adopted, "MCP grant adoption outcome");
    }
  } catch (err) {
    logger.warn(
      { event: "github_app_mcp_grant_failed", connectionId, err },
      "The GitHub App connect could not connect the GitHub MCP",
    );

    return { outcome: "failed", message: boundedMcpErrorText(err) };
  }
}

/**
 * The GitHub disconnect also ends chat access (owner rule 2026-11-13: one GitHub control).
 * Close the client and write `disconnected` first, so nothing opens the row again. Then remove
 * the tokens. Only a new GitHub connect opens it again.
 */
export async function detachGithubAppGrant(userId: string): Promise<void> {
  const connections = await listOwnedConnections(userId);

  const github = connections.find(
    (connection) => builtInProviderForEndpoint(connection.server.endpointUrl) === "github",
  );

  if (!github) return;

  await getMcpConnectionManager().disconnect(github.id, userId);
  await clearMcpOAuthGrant({ connectionId: github.id, userId });
}
