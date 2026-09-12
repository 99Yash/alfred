import type { McpConnection } from "./helpers";

/**
 * What one stored connection's state says to its owner.
 *
 * Both helpers take a connection that EXISTS. A tile with no row yet is a tile
 * concern, not a status concern: only the caller knows which words belong there
 * — what a first-class server buys, or what the generic add door is for — and
 * the caller already holds them.
 */
export function mcpConnectionStatusText(
  connection: Pick<McpConnection, "status" | "lastError">,
): string {
  switch (connection.status) {
    case "ready":
      return "Connected";
    case "auth_required":
      return connection.lastError ?? "Additional permissions require your consent.";
    case "connecting":
      return "Connecting…";
    case "disconnected":
      return "Disconnected";
    case "stale":
      return "Refreshing the tool catalog…";
    case "failed":
      return connection.lastError ?? "Connection failed";
    default: {
      const _exhaustive: never = connection.status;

      return _exhaustive;
    }
  }
}

/**
 * Status text plus the published tool count once a revision exists.
 *
 * The count is the one fact a connection can report without a call, so it is
 * folded into the status line rather than given a second field.
 */
export function mcpConnectionSubtitle(
  connection: Pick<McpConnection, "status" | "lastError" | "toolCount">,
): string {
  const status = mcpConnectionStatusText(connection);

  if (connection.status !== "ready" || connection.toolCount === null) return status;

  return `${status} · ${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`;
}
