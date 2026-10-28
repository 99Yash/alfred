import type { McpConnection } from "~/lib/integrations/mcp-connections";

/** The one-line amber alert. Present only for `failed`, or `connecting` after an error. */
export interface McpConnectionAlert {
  readonly text: string;
  /** The stored diagnostic, shown on hover and to screen readers. */
  readonly diagnostic: string | null;
}

/** What a connection that exists shows. A tile with no row writes its own copy. */
export interface McpConnectionPresentation {
  /** The full status line: the catalog status row and the start of the tile subtitle. */
  readonly statusText: string;
  /**
   * Non-null exactly when the tile shows the amber badge. The one-line alert
   * renders only when no action error (and, on the built-in card, no loading
   * state) takes the subtitle instead.
   */
  readonly alert: McpConnectionAlert | null;
}

export function mcpConnectionPresentation(
  connection: Pick<McpConnection, "status" | "lastError">,
): McpConnectionPresentation {
  const { lastError } = connection;

  switch (connection.status) {
    case "ready":
      return { statusText: "Connected", alert: null };
    case "auth_required":
      return {
        statusText: lastError ?? "Additional permissions require your consent.",
        alert: null,
      };
    case "connecting":
      return lastError === null
        ? { statusText: "Connecting…", alert: null }
        : {
            statusText: "Reconnecting…",
            alert: { text: "Reconnecting…", diagnostic: lastError },
          };
    case "disconnected":
      return { statusText: "Disconnected", alert: null };
    case "stale":
      return { statusText: "Refreshing the tool catalog…", alert: null };
    case "failed":
      return {
        statusText: lastError ?? "Connection failed",
        alert: { text: "Connection failed", diagnostic: lastError },
      };
    default: {
      const _exhaustive: never = connection.status;

      return { statusText: _exhaustive, alert: null };
    }
  }
}

/**
 * Whether the tile's main button asks for a repair. Every other status needs nothing
 * from the user, so its reconnect stays in the "..." menu.
 */
export function mcpConnectionNeedsRepair(connection: Pick<McpConnection, "status">): boolean {
  return connection.status === "failed" || connection.status === "disconnected";
}

/** Status text plus the published tool count once a revision exists. */
export function mcpConnectionSubtitle(
  connection: Pick<McpConnection, "status" | "lastError" | "toolCount">,
): string {
  const status = mcpConnectionPresentation(connection).statusText;

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
