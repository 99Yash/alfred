/**
 * Keep the Google Workspace MCP connections in step with the Google credential (ADR-0126).
 * The Google connect flow is the only consent. These connections follow it.
 */

import { getGoogleMcpAccessToken } from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { builtInBorrowsGoogleCredential, GOOGLE_WORKSPACE_BUILT_INS } from "./built-ins";
import { ensureBuiltInConnection, listOwnedConnections } from "./persistence";
import { getMcpConnectionManager } from "./runtime";

/**
 * With a usable Google credential, create each Google Workspace connection and connect it, so
 * its catalog publishes. Without one, disconnect each existing connection, so the model sees no
 * Google MCP tools. Each server settles alone, and a failure stays on its row.
 * `no_credential` tells a caller to send the user to the Google connect flow.
 */
export async function syncGoogleWorkspaceConnections(
  userId: string,
): Promise<"synced" | "no_credential"> {
  const manager = getMcpConnectionManager();

  if ((await getGoogleMcpAccessToken(userId)) === null) {
    const owned = await listOwnedConnections(userId);

    await Promise.allSettled(
      owned
        .filter((connection) => builtInBorrowsGoogleCredential(connection.server.endpointUrl))
        .map((connection) => manager.disconnect(connection.id, userId)),
    );

    return "no_credential";
  }

  const results = await Promise.allSettled(
    GOOGLE_WORKSPACE_BUILT_INS.map(async (provider) => {
      const connection = await ensureBuiltInConnection(userId, provider);

      return { provider, outcome: await manager.reconnect(connection.id, userId) };
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "[mcp.google] could not connect a Google MCP server");
    } else if (result.value.outcome.outcome !== "connected") {
      logger.warn(
        { provider: result.value.provider, outcome: result.value.outcome },
        "[mcp.google] a Google MCP server did not connect",
      );
    }
  }

  return "synced";
}
