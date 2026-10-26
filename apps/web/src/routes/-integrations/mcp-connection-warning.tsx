import type { McpConnectionAlert } from "./mcp-server-status";

/**
 * One line, like every other tile subtitle. The stored diagnostic shows on hover and in
 * full in the tools panel, so a long error never stretches the tile.
 */
export function McpConnectionWarning({ alert }: { alert: McpConnectionAlert }) {
  return (
    <p role="alert" title={alert.diagnostic ?? undefined} className="flex min-w-0">
      <span className="truncate">{alert.text}</span>
      {alert.diagnostic ? <span className="sr-only">: {alert.diagnostic}</span> : null}
    </p>
  );
}
