import type { McpConnection } from "./helpers";

/**
 * One line, like every other tile subtitle. The stored diagnostic shows on hover and in
 * full in the tools panel, so a long error never stretches the tile.
 */
export function McpConnectionWarning({
  connection,
}: {
  connection: Pick<McpConnection, "status" | "lastError">;
}) {
  return (
    <p role="alert" title={connection.lastError ?? undefined} className="flex min-w-0">
      <span className="truncate">
        {connection.status === "connecting" ? "Reconnecting…" : "Connection failed"}
      </span>
      {connection.lastError ? <span className="sr-only">: {connection.lastError}</span> : null}
    </p>
  );
}
