import { AlertTriangle, RotateCw } from "lucide-react";
import { Favicon } from "~/components/favicon";
import { AppButton } from "~/components/ui/v2";
import { mcpAuthorizeUrl } from "./helpers";
import { mcpConnectionFaviconDomain, type McpConnection } from "~/lib/integrations/mcp-connections";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";
import { useMcpConnectionActions, type McpConnectionActions } from "./mcp-connection-actions";
import { McpActionErrorText, McpConnectionMenu } from "./mcp-connection-menu";
import { McpConnectionWarning } from "./mcp-connection-warning";
import { McpTile } from "./mcp-tile";
import { mcpConnectionPresentation, mcpConnectionSubtitle } from "./mcp-server-status";

export interface McpConnectionCardViewProps {
  connection: McpConnection;
  actions: McpConnectionActions;
}

/**
 * One user-added MCP server, rendered from props so `renderToStaticMarkup` can test it.
 * Like a built-in tile, it has one main button; the rest is in the "..." menu.
 * `auth_required` has no usable credential (`reconnect` returns 400), so it
 * navigates to consent instead of offering Reconnect.
 */
export function McpConnectionCardView({ connection, actions }: McpConnectionCardViewProps) {
  const needsConsent = connection.status === "auth_required";

  const { alert } = mcpConnectionPresentation(connection);

  const busy = actions.pending !== null;

  const subtitle = actions.error ? (
    <McpActionErrorText error={actions.error} />
  ) : alert ? (
    <McpConnectionWarning alert={alert} />
  ) : (
    mcpConnectionSubtitle(connection)
  );

  return (
    <McpTile
      icon={{
        glyph: <Favicon domain={mcpConnectionFaviconDomain(connection)} size={20} />,
      }}
      label={connection.label}
      subtitle={subtitle}
      warning={alert !== null}
    >
      {needsConsent ? (
        <AppButton
          size="sm"
          variant="white"
          leading={<AlertTriangle size={12} />}
          onClick={() => {
            openAuthorizationTab(mcpAuthorizeUrl(connection.id));
          }}
        >
          Grant access
        </AppButton>
      ) : (
        <AppButton
          size="sm"
          variant="white"
          leading={<RotateCw size={12} />}
          loading={actions.pending === "reconnect"}
          disabled={busy && actions.pending !== "reconnect"}
          onClick={actions.onReconnect}
        >
          {connection.status === "disconnected" ? "Connect" : "Reconnect"}
        </AppButton>
      )}
      <McpConnectionMenu connection={connection} actions={actions} custom />
    </McpTile>
  );
}

/** Owns the lifecycle hook, so the view stays hook-free. */
export function McpConnectionCard({ connection }: { connection: McpConnection }) {
  const actions = useMcpConnectionActions(connection);

  return <McpConnectionCardView connection={connection} actions={actions} />;
}
