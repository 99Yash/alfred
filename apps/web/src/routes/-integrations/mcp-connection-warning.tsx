import { AlertTriangle } from "lucide-react";
import type { McpConnection } from "./helpers";

/** Show a short failure reason first; keep the stored diagnostic available in full. */
export function McpConnectionWarning({
  connection,
}: {
  connection: Pick<McpConnection, "status" | "lastError">;
}) {
  return (
    <div role="alert" className="space-y-1">
      <span className="flex items-center gap-1">
        <AlertTriangle size={12} aria-hidden />
        {connection.status === "connecting"
          ? "Reconnecting to this MCP server…"
          : "Could not connect to this MCP server."}
      </span>
      {connection.lastError ? (
        <details>
          <summary className="cursor-pointer underline">Error details</summary>
          <p className="mt-1 break-all whitespace-pre-wrap text-app-fg-3">{connection.lastError}</p>
        </details>
      ) : null}
    </div>
  );
}
