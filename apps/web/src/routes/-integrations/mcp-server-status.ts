import type { McpConnection } from "~/lib/integrations/mcp-connections";

/**
 * The alert of a ready connection whose current catalog dropped its read endpoint
 * (ADR-0130 decision 9). The main endpoint serves every tool, so each read asks for approval.
 */
const READ_ENDPOINT_FAULT_ALERT_TEXT = "Reads ask for approval";

/** The fields that decide what a connection shows. */
type McpConnectionStatusFields = Pick<McpConnection, "status" | "lastError" | "readEndpointFault">;

/** The one-line amber alert. Present for `failed`, `connecting` after an error, and `ready` with a dropped read endpoint. */
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
  connection: McpConnectionStatusFields,
): McpConnectionPresentation {
  const { lastError, readEndpointFault } = connection;

  switch (connection.status) {
    case "ready":
      // Only the catalog activation writes `readEndpointFault`, so no other error shows here.
      return readEndpointFault === null
        ? { statusText: "Connected", alert: null }
        : {
            statusText: "Connected",
            alert: { text: READ_ENDPOINT_FAULT_ALERT_TEXT, diagnostic: readEndpointFault },
          };
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
    default:
      // The connection list arrives as an unparsed HTTP response, so a newer server value can reach this clause.
      return { statusText: "Unknown status", alert: null };
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
  connection: McpConnectionStatusFields & Pick<McpConnection, "toolCount">,
): string {
  const status = mcpConnectionPresentation(connection).statusText;

  if (connection.status !== "ready" || connection.toolCount === null) return status;

  return `${status} · ${connection.toolCount} ${connection.toolCount === 1 ? "tool" : "tools"}`;
}

/** Status, tool count, and last successful connect (omitted until the first one). */
export function mcpConnectionHealthText(
  connection: McpConnectionStatusFields & Pick<McpConnection, "toolCount" | "lastConnectedAt">,
): string {
  const base = mcpConnectionSubtitle(connection);

  if (connection.lastConnectedAt === null) return base;

  return `${base} · Last connected ${connection.lastConnectedAt.toLocaleString()}`;
}
