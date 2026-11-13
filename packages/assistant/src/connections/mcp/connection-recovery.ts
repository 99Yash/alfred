/**
 * Two bounded background passes over MCP connections that hold a stored grant:
 * - recovery: re-probe stalled connections;
 * - keep-alive: refresh each OAuth grant at least once a day, because some servers end a grant
 *   that is not used. The owner decision of 2026-10-22 (product-direction.md, "Custody") says
 *   Alfred refreshes MCP OAuth at intervals and shows when a session needs the user again.
 */
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { logger } from "@alfred/logging";
import { MCP_DEFAULT_REQUEST_TIMEOUT_MS, MCP_RECONNECT_MESSAGE } from "./client";
import { getMcpEndpointAuthorizer, withMcpEndpointAuthorization } from "./endpoint-authorization";
import { mcpOAuthProviderForConnection, type McpOAuthRefreshOutcome } from "./oauth";
import {
  closeKeepAliveFailureRun,
  listOAuthConnectionsToKeepAlive,
  listRecoverableCredentialedConnectionIds,
  markKeepAliveAttempted,
  openKeepAliveFailureRun,
  type McpOAuthKeepAliveCandidate,
  type McpOAuthKeepAliveTarget,
} from "./persistence";

import { getMcpConnectionManager } from "./runtime";

const RECOVERY_INTERVAL_MS = 5 * 60_000;

const RECOVERY_QUIET_MS = 2 * 60_000;

const RECOVERY_PAGE_SIZE = 10;

/** Hourly, so a transient failure is retried within the hour and not on every recovery pass. */
const KEEPALIVE_INTERVAL_MS = 60 * 60_000;

/** A row attempted in this window waits. The slack keeps a failing row on the next hourly pass. */
const KEEPALIVE_RETRY_AFTER_MS = KEEPALIVE_INTERVAL_MS - 5 * 60_000;

/** A grant with no refresh in this window gets one. A used connection refreshes on its own. */
const KEEPALIVE_MAX_IDLE_MS = 24 * 60 * 60_000;

/** After this run of failures, ask the owner to reconnect. Nango stops after 4 failing days. */
const KEEPALIVE_GIVE_UP_AFTER_MS = 72 * 60 * 60_000;

const KEEPALIVE_PAGE_SIZE = 10;

const KEEPALIVE_GAVE_UP_MESSAGE =
  "The MCP server refused every sign-in refresh for 3 days; reconnect it to continue.";

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

/** A refresh failure that may pass. Give up only when the failure run is long enough. */
async function recordKeepAliveFailure(
  connection: McpOAuthKeepAliveCandidate,
  target: McpOAuthKeepAliveTarget,
  err: unknown,
): Promise<void> {
  const run = await openKeepAliveFailureRun(target, new Date());

  if (!run || Date.now() - run.failingSince.getTime() < KEEPALIVE_GIVE_UP_AFTER_MS) {
    // The refresh token stays, and the next hourly pass tries again.
    logger.warn(
      { event: "mcp_oauth_keepalive_failed", connectionId: connection.id, err },
      "MCP OAuth keep-alive refresh failed; retrying on the next pass",
    );

    return;
  }

  // The run's grant: a grant saved after the run's write is newer, and it wins.
  await getMcpConnectionManager().markGrantEnded(connection.id, {
    credentialId: connection.credentialId,
    grantAuthorizedAt: run.grantAuthorizedAt,
    lastError: KEEPALIVE_GAVE_UP_MESSAGE,
  });
  logger.warn(
    { event: "mcp_oauth_keepalive_gave_up", connectionId: connection.id, err },
    "MCP OAuth keep-alive refresh failed for 72 hours; the owner must reconnect",
  );
}

async function keepAliveConnection(
  connection: McpOAuthKeepAliveCandidate,
  staleBefore: Date,
): Promise<void> {
  const target: McpOAuthKeepAliveTarget = {
    connectionId: connection.id,
    credentialId: connection.credentialId,
  };

  await markKeepAliveAttempted(target, new Date());

  let outcome: McpOAuthRefreshOutcome;

  try {
    outcome = await withMcpEndpointAuthorization(
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
  } catch (err) {
    await recordKeepAliveFailure(connection, target, err);

    return;
  }

  if (outcome.verdict === "fresh") {
    await closeKeepAliveFailureRun(target);

    return;
  }

  // The refresh already cleared the dead tokens. Show it now, not at the next call. The lock is
  // gone by now, so a grant saved since then (a consent, a GitHub App adopt) must win.
  await getMcpConnectionManager().markGrantEnded(connection.id, {
    credentialId: connection.credentialId,
    grantAuthorizedAt: outcome.grantAuthorizedAt,
    lastError: MCP_RECONNECT_MESSAGE,
  });
}

const keepAlive = new PeriodicTask({
  name: "mcp-oauth-keepalive",
  intervalMs: KEEPALIVE_INTERVAL_MS,
  async pass(signal) {
    const now = Date.now();
    const staleBefore = new Date(now - KEEPALIVE_MAX_IDLE_MS);

    const connections = await listOAuthConnectionsToKeepAlive({
      staleBefore,
      attemptedBefore: new Date(now - KEEPALIVE_RETRY_AFTER_MS),
      limit: KEEPALIVE_PAGE_SIZE,
    });

    for (const connection of connections) {
      if (signal.aborted) return;

      try {
        await keepAliveConnection(connection, staleBefore);
      } catch (err) {
        // A bookkeeping or status write failed. The next pass reads the row again.
        logger.warn(
          { event: "mcp_oauth_keepalive_write_failed", connectionId: connection.id, err },
          "MCP OAuth keep-alive could not record its outcome",
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
