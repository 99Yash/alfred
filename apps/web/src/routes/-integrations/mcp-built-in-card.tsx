import { BUILT_IN_MCP_CATALOG, type BuiltInMCPProvider } from "@alfred/contracts";
import { AlertTriangle, Plus } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { mcpAuthorizeUrl, mcpBuiltInConnectUrl, type McpConnection } from "./helpers";
import { mcpConnectionSubtitle } from "./mcp-server-status";
import { McpConnectionWarning } from "./mcp-connection-warning";
import { McpTile } from "./mcp-tile";

/**
 * What the card has to say, as ONE closed cascade.
 *
 * The subtitle, the button text, the disabled rule and the destination all read
 * the same five states. Deriving them separately meant writing the cascade
 * twice, and the two copies were already ordered differently.
 */
type BuiltInState =
  | { readonly kind: "loading"; readonly connection: McpConnection | undefined }
  | { readonly kind: "read_error"; readonly connection: McpConnection | undefined }
  | { readonly kind: "absent" }
  | { readonly kind: "connecting"; readonly connection: McpConnection }
  | { readonly kind: "needs_consent"; readonly connection: McpConnection }
  | { readonly kind: "connected"; readonly connection: McpConnection };

/**
 * A stored row that needs the owner's attention. One predicate, read off the
 * stored connection wherever it appears, so the amber ring, the warning copy,
 * and the detailsExpander can't disagree: a warning ring always rides with an
 * icon and a message, never as a colour-only signal.
 */
function isWarningConnection(connection: McpConnection): boolean {
  return (
    connection.status === "failed" ||
    (connection.status === "connecting" && connection.lastError !== null)
  );
}

/** The states in the order the owner meets them. */
function builtInState(input: {
  connection: McpConnection | undefined;
  loading: boolean;
  readError: boolean;
}): BuiltInState {
  // Loading and read errors keep the cached row (when one exists) so the
  // label, the warning predicate, and the subtitle all read the same
  // connection. Dropping it here is what left a failed cached row as an amber
  // ring with generic "could not load" copy and no details.
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

/**
 * One first-class MCP server: the pinned endpoint the registry supplies, behind
 * one button.
 *
 * It is not {@link McpConnectionCard} with a different icon. A generic card acts
 * on a row that already exists, so its actions are fetch mutations. This tile
 * may act BEFORE any row exists — the connect route ensures the row itself — and
 * every action it offers ends at an authorization server, which is a browser
 * NAVIGATION, not a fetch. That is why nothing here is a mutation and why the
 * connection is optional.
 *
 * The connect door is keyed by the provider, so this component serves every
 * entry in `MCP_BUILT_IN_CATALOG` and the next built-in adds no code here.
 */
export function McpBuiltInCard({
  provider,
  connection,
  loading,
  readError,
  onRetry,
}: {
  provider: BuiltInMCPProvider;
  /** Absent until the owner connects this server for the first time. */
  connection: McpConnection | undefined;
  loading: boolean;
  readError: boolean;
  onRetry: () => void;
}) {
  const entry = BUILT_IN_MCP_CATALOG[provider];
  const state = builtInState({ connection, loading, readError });

  const stateConnection = "connection" in state ? state.connection : undefined;

  const warning = stateConnection !== undefined && isWarningConnection(stateConnection);

  const subtitle =
    state.kind === "loading" ? (
      "Loading connection…"
    ) : state.kind === "read_error" ? (
      // A cached failed row keeps its warning copy and details behind the
      // retry: the amber ring below always rides with a message, never alone.
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
      // A catalog entry names a PROVIDER slug, and every provider entry carries
      // brand artwork, so there is no glyph case to fall back to.
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
        leading={state.kind === "needs_consent" ? <AlertTriangle size={12} /> : <Plus size={12} />}
        disabled={state.kind === "loading" || state.kind === "connecting"}
        onClick={() => {
          if (state.kind === "read_error") {
            onRetry();

            return;
          }

          // A row that waits for consent walks to the connection's OWN consent
          // door, the same one the generic card uses. The card does not decide
          // whether the authorization server must show a screen: `mcpConsentAsk`
          // forces one whenever the ask exceeds the stored grant.
          openAuthorizationTab(
            state.kind === "needs_consent"
              ? mcpAuthorizeUrl(state.connection.id)
              : mcpBuiltInConnectUrl(provider),
          );
        }}
      >
        {ACTION_LABEL[state.kind]}
      </AppButton>
    </McpTile>
  );
}
