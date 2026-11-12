/**
 * The GitHub App install connects the GitHub MCP too (ADR-0093 amendment 2026-11-12).
 * The built-in uses the App's own OAuth client, so the user token from the install is a
 * valid grant for the MCP endpoint. The MCP row becomes the only holder that refreshes it:
 * GitHub rotates the refresh token on each use.
 */

import { serverEnv } from "@alfred/env/server";
import type { ExchangeUserCodeResult } from "@alfred/integrations/github";
import { logger } from "@alfred/logging";

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

/** On `failed`, the row holds the outcome. The install itself still succeeded. */
export type GithubAppGrantOutcome = "connected" | "failed";

/**
 * Store `grant` on the user's GitHub MCP connection and open the client. It never throws:
 * the manager writes a failure to the row, and the integrations page shows it.
 */
export async function adoptGithubAppGrant(input: {
  readonly userId: string;
  readonly grant: GithubAppUserGrant;
}): Promise<GithubAppGrantOutcome> {
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
            clientId: serverEnv().GITHUB_APP_CLIENT_ID,
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

    return "connected";
  } catch (err) {
    logger.warn(
      { event: "github_app_mcp_grant_failed", connectionId, err },
      "The GitHub App install could not connect the GitHub MCP",
    );

    return "failed";
  }
}
