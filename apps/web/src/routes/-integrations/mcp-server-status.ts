import type { McpConnection } from "./helpers";

/** Status text for a connection that exists. A tile with no row writes its own copy. */
export function mcpConnectionStatusText(
  connection: Pick<McpConnection, "status" | "lastError">,
): string {
  switch (connection.status) {
    case "ready":
      return "Connected";
    case "auth_required":
      return connection.lastError ?? "Additional permissions require your consent.";
    case "connecting":
      return connection.lastError ? "Reconnecting…" : "Connecting…";
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

/** Status text plus the published tool count once a revision exists. */
export function mcpConnectionSubtitle(
  connection: Pick<McpConnection, "status" | "lastError" | "toolCount">,
): string {
  const status = mcpConnectionStatusText(connection);

  if (connection.status !== "ready" || connection.toolCount === null) return status;

  return `${status} · ${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`;
}

/** Status, tool count, and last successful connect (omitted until the first one). */
export function mcpConnectionHealthText(
  connection: Pick<McpConnection, "status" | "lastError" | "toolCount" | "lastConnectedAt">,
): string {
  const base = mcpConnectionSubtitle(connection);

  if (connection.lastConnectedAt === null) return base;

  return `${base} · Last connected ${connection.lastConnectedAt.toLocaleString()}`;
}
