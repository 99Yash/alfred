import { BUILT_IN_MCP_CATALOG, type BuiltInMCPProvider } from "@alfred/contracts";
import { AlertTriangle, Plus } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { mcpAuthorizeUrl, mcpBuiltInConnectUrl, type McpConnection } from "./helpers";
import { mcpConnectionSubtitle } from "./mcp-server-status";
import { McpTile } from "./mcp-tile";

/**
 * What the card has to say, as ONE closed cascade.
 *
 * The subtitle, the button text, the disabled rule and the destination all read
 * the same five states. Deriving them separately meant writing the cascade
 * twice, and the two copies were already ordered differently.
 */
type BuiltInState =
  | { readonly kind: "loading" }
  | { readonly kind: "read_error" }
  | { readonly kind: "absent" }
  | { readonly kind: "connecting"; readonly connection: McpConnection }
  | { readonly kind: "needs_consent"; readonly connection: McpConnection }
  | { readonly kind: "connected"; readonly connection: McpConnection };

/** The states in the order the owner meets them. */
function builtInState(input: {
  connection: McpConnection | undefined;
  loading: boolean;
  readError: boolean;
}): BuiltInState {
  if (input.loading) return { kind: "loading" };

  if (input.readError) return { kind: "read_error" };
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

  const subtitle =
    state.kind === "loading"
      ? "Loading connection…"
      : state.kind === "read_error"
        ? "Could not load connection status."
        : state.kind === "absent"
          ? entry.blurb
          : mcpConnectionSubtitle(state.connection);

  return (
    <McpTile
      // A catalog entry names a PROVIDER slug, and every provider entry carries
      // brand artwork, so there is no glyph case to fall back to.
      icon={{
        brand: brandForIntegration(entry.slug),
        connected: state.kind === "connected" && state.connection.status === "ready",
      }}
      label={connection?.label ?? entry.label}
      subtitle={subtitle}
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
          window.location.href =
            state.kind === "needs_consent"
              ? mcpAuthorizeUrl(state.connection.id)
              : mcpBuiltInConnectUrl(provider);
        }}
      >
        {ACTION_LABEL[state.kind]}
      </AppButton>
    </McpTile>
  );
}
