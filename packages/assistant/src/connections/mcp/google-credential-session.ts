/**
 * The token session of a Google Workspace MCP connection (ADR-0126). The connection holds no
 * grant. Each request borrows the access token of the user's Google credential, and the Google
 * credential code refreshes it. One row refreshes, and one row holds the auth state.
 */

import { integrationRoutePrefix } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { getGoogleMcpAccessToken } from "@alfred/integrations/google";
import type { McpTokenSession } from "./client";
import { McpOAuthAuthorizationRequiredError } from "./oauth";

/** The owner-facing text when only a Google reconnect can bring the connection back. */
export const GOOGLE_RECONNECT_MESSAGE = "Reconnect Google to continue.";

/** The Google connect flow. It is an API route, so it goes on the API origin (`BETTER_AUTH_URL`). */
function googleConnectUrl(): URL {
  return new URL(
    `${serverEnv().BETTER_AUTH_URL.replace(/\/$/, "")}${integrationRoutePrefix("google")}/connect`,
  );
}

/** Only the Google connect flow can repair the credential, so `authorizationUrl` is that flow. */
class McpGoogleCredentialRequiredError extends McpOAuthAuthorizationRequiredError {
  constructor() {
    super(googleConnectUrl());
    this.name = "McpGoogleCredentialRequiredError";
    this.message = GOOGLE_RECONNECT_MESSAGE;
  }
}

/**
 * A session over the user's Google credential. `refreshIfNeeded` reads the token before each
 * call, so a missing or refused credential stops the call before it starts.
 */
export function googleCredentialTokenSession(userId: string): McpTokenSession {
  const accessToken = async (): Promise<string> => {
    const token = await getGoogleMcpAccessToken(userId);

    if (token === null) throw new McpGoogleCredentialRequiredError();

    return token;
  };

  return {
    accessToken,
    refreshIfNeeded: async () => {
      await accessToken();
    },
    // The Google row refreshes near expiry only. A different stored token means that a refresh
    // ran after the rejected request, so one more try can work.
    renewRejectedToken: async (rejectedAccessToken) => {
      try {
        return (await accessToken()) !== rejectedAccessToken;
      } catch (error) {
        if (error instanceof McpGoogleCredentialRequiredError) return false;

        throw error;
      }
    },
  };
}
