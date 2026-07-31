import type { McpConnectionStatus } from "@alfred/contracts";
import { MCP_SECTION } from "./helpers";

export function mcpConnectionStatusText(
  connection: { status: McpConnectionStatus; lastError: string | null } | undefined,
): string {
  if (!connection) return MCP_SECTION.description;
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
