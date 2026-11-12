/**
 * Two bounded background passes over MCP connections that hold a stored grant:
 * - recovery: re-probe stalled connections;
 * - keep-alive: refresh each OAuth grant at least once a day, because some servers end a grant
 *   that is not used. The owner decision of 2026-10-22 (product-direction.md, "Custody") says
 *   Alfred refreshes MCP OAuth at intervals and shows when a session needs the user again.
 */
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { logger } from "@alfred/logging";
import { MCP_DEFAULT_REQUEST_TIMEOUT_MS } from "./client";
import { getMcpEndpointAuthorizer, withMcpEndpointAuthorization } from "./endpoint-authorization";
import { mcpOAuthProviderForConnection } from "./oauth";
import {
  listOAuthConnectionsToKeepAlive,
  listRecoverableCredentialedConnectionIds,
  updateConnection,
} from "./persistence";

import { getMcpConnectionManager } from "./runtime";

const RECOVERY_INTERVAL_MS = 5 * 60_000;

const RECOVERY_QUIET_MS = 2 * 60_000;

const RECOVERY_PAGE_SIZE = 10;

/** Hourly, so a transient failure is retried within the hour and not on every recovery pass. */
const KEEPALIVE_INTERVAL_MS = 60 * 60_000;

/** A grant with no refresh in this window gets one. A used connection refreshes on its own. */
const KEEPALIVE_MAX_IDLE_MS = 24 * 60 * 60_000;

const KEEPALIVE_PAGE_SIZE = 10;

const recovery = new PeriodicTask({
  name: "mcp-connection-recovery",
  intervalMs: RECOVERY_INTERVAL_MS,
  async pass(signal) {
    const ids = await listRecoverableCredentialedConnectionIds(
      new Date(Date.now() - RECOVERY_QUIET_MS),
      RECOVERY_PAGE_SIZE,
    );

    for (const id of ids) {
      if (signal.aborted) return;

      try {
        await getMcpConnectionManager().getReadyClient(id);
      } catch {
        // The manager already stored the outcome. Writing `connecting` here would stick dead hosts on "Reconnecting".
      }
    }
  },
});

const keepAlive = new PeriodicTask({
  name: "mcp-oauth-keepalive",
  intervalMs: KEEPALIVE_INTERVAL_MS,
  async pass(signal) {
    const staleBefore = new Date(Date.now() - KEEPALIVE_MAX_IDLE_MS);
    const connections = await listOAuthConnectionsToKeepAlive(staleBefore, KEEPALIVE_PAGE_SIZE);

    for (const connection of connections) {
      if (signal.aborted) return;

      try {
        const outcome = await withMcpEndpointAuthorization(
          getMcpEndpointAuthorizer(),
          connection.server,
          { requestTimeoutMs: MCP_DEFAULT_REQUEST_TIMEOUT_MS },
          (authorized) =>
            mcpOAuthProviderForConnection({
              id: connection.id,
              userId: connection.userId,
              authorization: authorized.oauth,
            }).keepAlive(staleBefore),
        );

        // The refresh already cleared the dead tokens. Show it now, not at the next call.
        if (outcome === "dead") {
          await updateConnection(connection.id, {
            status: "auth_required",
            lastError: "Reconnect this MCP server to continue.",
          });
        }
      } catch (err) {
        // Transient: the refresh token stays, and the next hourly pass tries again.
        logger.warn(
          { event: "mcp_oauth_keepalive_failed", connectionId: connection.id, err },
          "MCP OAuth keep-alive refresh failed; retrying on the next pass",
        );
      }
    }
  },
});

export function startMcpConnectionRecovery(): void {
  recovery.start();
  keepAlive.start();
}

export async function stopMcpConnectionRecovery(): Promise<void> {
  await Promise.all([recovery.stop(), keepAlive.stop()]);
}
