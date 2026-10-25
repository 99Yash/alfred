import { BUILT_IN_MCP_CATALOG, type BuiltInMCPProvider } from "@alfred/contracts";
import type { ReactNode } from "react";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { mcpAuthorizeUrl, mcpBuiltInConnectUrl, type McpConnection } from "./helpers";
import { useMcpConnectionActions, type McpConnectionActions } from "./mcp-connection-actions";
import { McpActionErrorText, McpConnectionMenu } from "./mcp-connection-menu";
import { mcpConnectionSubtitle } from "./mcp-server-status";
import { McpConnectionWarning } from "./mcp-connection-warning";
import { McpTile } from "./mcp-tile";

/** One closed state that drives the subtitle, button text, disabled rule, and destination. */
type BuiltInState =
  | { readonly kind: "loading"; readonly connection: McpConnection | undefined }
  | { readonly kind: "read_error"; readonly connection: McpConnection | undefined }
  | { readonly kind: "absent" }
  | { readonly kind: "connecting"; readonly connection: McpConnection }
  | { readonly kind: "needs_consent"; readonly connection: McpConnection }
  | { readonly kind: "connected"; readonly connection: McpConnection };

/** One predicate, so the amber badge never shows without its message. */
function isWarningConnection(connection: McpConnection): boolean {
  return (
    connection.status === "failed" ||
    (connection.status === "connecting" && connection.lastError !== null)
  );
}

function builtInState(input: {
  connection: McpConnection | undefined;
  loading: boolean;
  readError: boolean;
}): BuiltInState {
  // Keep the cached row while loading or after a read error, so the copy matches the ring.
  if (input.loading) return { kind: "loading", connection: input.connection };

  if (input.readError) return { kind: "read_error", connection: input.connection };
  const { connection } = input;

  if (!connection) return { kind: "absent" };

  if (connection.status === "connecting") return { kind: "connecting", connection };

  if (connection.status === "auth_required") return { kind: "needs_consent", connection };

  return { kind: "connected", connection };
}

const ACTION_LABEL = {
  loading: "Loading",
  read_error: "Retry",
  absent: "Add",
  connecting: "Connecting",
  needs_consent: "Grant access",
  connected: "Reconnect",
} satisfies Record<BuiltInState["kind"], string>;

interface McpBuiltInCardProps {
  provider: BuiltInMCPProvider;
  /** Absent until the first connect. */
  connection: McpConnection | undefined;
  loading: boolean;
  readError: boolean;
  onRetry: () => void;
}

const ACTION_ICON = {
  loading: <Plus size={12} />,
  read_error: <RotateCw size={12} />,
  absent: <Plus size={12} />,
  connecting: <Plus size={12} />,
  needs_consent: <AlertTriangle size={12} />,
  connected: <RotateCw size={12} />,
} satisfies Record<BuiltInState["kind"], ReactNode>;

/**
 * One built-in MCP server: one main button, plus the "..." menu once a row exists.
 * Unlike {@link McpConnectionCard}, it can act before a row exists, and the main
 * button is a browser navigation to an authorization server, not a fetch.
 */
export function McpBuiltInCard(props: McpBuiltInCardProps) {
  // The lifecycle hook needs a row, so it lives in a child that only mounts with one.
  if (props.connection)
    return <McpBuiltInCardWithActions {...props} connection={props.connection} />;

  return <McpBuiltInCardView {...props} actions={null} />;
}

function McpBuiltInCardWithActions(props: McpBuiltInCardProps & { connection: McpConnection }) {
  const actions = useMcpConnectionActions(props.connection);

  return <McpBuiltInCardView {...props} actions={actions} />;
}

function McpBuiltInCardView({
  provider,
  connection,
  loading,
  readError,
  onRetry,
  actions,
}: McpBuiltInCardProps & { actions: McpConnectionActions | null }) {
  const entry = BUILT_IN_MCP_CATALOG[provider];
  const state = builtInState({ connection, loading, readError });

  const stateConnection = "connection" in state ? state.connection : undefined;

  const warning = stateConnection !== undefined && isWarningConnection(stateConnection);

  const subtitle = actions?.error ? (
    <McpActionErrorText error={actions.error} />
  ) : state.kind === "loading" ? (
    "Loading connection…"
  ) : state.kind === "read_error" ? (
    stateConnection && isWarningConnection(stateConnection) ? (
      <McpConnectionWarning connection={stateConnection} />
    ) : (
      "Could not load connection status."
    )
  ) : state.kind === "absent" ? (
    entry.blurb
  ) : isWarningConnection(state.connection) ? (
    <McpConnectionWarning connection={state.connection} />
  ) : (
    mcpConnectionSubtitle(state.connection)
  );

  return (
    <McpTile
      // Catalog entries are provider slugs, and every provider has brand artwork.
      icon={{
        brand: brandForIntegration(entry.slug),
        connected: state.kind === "connected" && state.connection.status === "ready",
      }}
      label={stateConnection?.label ?? entry.label}
      subtitle={subtitle}
      warning={warning}
    >
      <AppButton
        size="sm"
        variant="white"
        leading={ACTION_ICON[state.kind]}
        disabled={state.kind === "loading" || state.kind === "connecting"}
        onClick={() => {
          if (state.kind === "read_error") {
            onRetry();

            return;
          }

          // The connection's own consent door. `mcpConsentAsk` decides if a screen is needed.
          openAuthorizationTab(
            state.kind === "needs_consent"
              ? mcpAuthorizeUrl(state.connection.id)
              : mcpBuiltInConnectUrl(provider),
          );
        }}
      >
        {ACTION_LABEL[state.kind]}
      </AppButton>
      {connection && actions ? (
        <McpConnectionMenu connection={connection} actions={actions} custom={false} />
      ) : null}
    </McpTile>
  );
}
