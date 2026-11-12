/**
 * The GitHub App install connects the GitHub MCP too (ADR-0093 amendment 2026-11-12).
 * The built-in uses the App's own OAuth client, so the user token from the install is a
 * valid grant for the MCP endpoint. The MCP row becomes the only holder that refreshes it:
 * GitHub rotates the refresh token on each use.
 */

import { serverEnv } from "@alfred/env/server";
import type { ExchangeUserCodeResult } from "@alfred/integrations/github";
import { logger } from "@alfred/logging";

import { BUILT_IN_REGISTRY } from "./built-ins";
import { MCP_DEFAULT_REQUEST_TIMEOUT_MS } from "./client";
import { getMcpEndpointAuthorizer, withMcpEndpointAuthorization } from "./endpoint-authorization";
import { mcpOAuthProviderForConnection } from "./oauth";
import { ensureBuiltInConnection } from "./persistence";
import { getMcpConnectionManager } from "./runtime";

/** The grant half of the App's token response. `exchangeUserCode` owns the shape. */
export type GithubAppUserGrant = Pick<
  ExchangeUserCodeResult,
  "accessToken" | "refreshToken" | "tokenType" | "expiresInSeconds" | "scopes"
>;

/**
 * Store `grant` on the user's GitHub MCP connection and open the client. It never throws, and
 * the caller needs no result: the manager writes the outcome to the row, and the integrations
 * page shows it. A row that keeps a working catalog after a failure gets only the log line.
 */
export async function adoptGithubAppGrant(input: {
  readonly userId: string;
  readonly grant: GithubAppUserGrant;
}): Promise<void> {
  let connectionId: string | undefined;

  try {
    const connection = await ensureBuiltInConnection(input.userId, "github");
    connectionId = connection.id;

    await getMcpConnectionManager().adoptGrant(connection.id, input.userId, () =>
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
  } catch (err) {
    logger.warn(
      { event: "github_app_mcp_grant_failed", connectionId, err },
      "The GitHub App install could not connect the GitHub MCP",
    );
  }
}
