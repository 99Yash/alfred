import { MCP_BUILT_IN_CATALOG, type McpBuiltInProvider } from "@alfred/contracts";
import { AlertTriangle, Plug, Plus } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { API_URL } from "~/lib/eden";
import { brandForIntegration } from "~/lib/integrations/integrations";
import type { McpConnection } from "./mcp-connection-card";
import { mcpConnectionSubtitle } from "./mcp-server-status";
import { McpTile } from "./mcp-tile";

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
 * entry in `MCP_BUILT_IN_CATALOG` and a fourth built-in adds no code here.
 */
export function McpBuiltInCard({
  provider,
  connection,
  loading,
  readError,
  onRetry,
}: {
  provider: McpBuiltInProvider;
  /** Absent until the owner connects this server for the first time. */
  connection: McpConnection | undefined;
  loading: boolean;
  readError: boolean;
  onRetry: () => void;
}) {
  const entry = MCP_BUILT_IN_CATALOG[provider];
  const brand = brandForIntegration(entry.slug);
  const connecting = connection?.status === "connecting";
  const needsConsent = connection?.status === "auth_required";

  // Four states, in the order the owner meets them: the list is still loading,
  // the list failed to load, no row exists yet, or a row has something to say.
  const subtitle = loading
    ? "Loading connection…"
    : readError
      ? "Could not load connection status."
      : connection
        ? mcpConnectionSubtitle(connection)
        : entry.blurb;

  return (
    <McpTile
      // A provider entry always has brand artwork; the fallback covers a slug
      // that is a non-provider registry entry, which the type still admits.
      icon={
        brand ? { brand, connected: connection?.status === "ready" } : { glyph: <Plug size={18} /> }
      }
      label={connection?.label ?? entry.label}
      subtitle={subtitle}
    >
      <AppButton
        size="sm"
        variant="white"
        leading={needsConsent ? <AlertTriangle size={12} /> : <Plus size={12} />}
        disabled={loading || connecting}
        onClick={() => {
          if (readError) {
            onRetry();

            return;
          }

          // `reconsent` forces a consent screen, which is what a WIDENED scope
          // baseline over a live grant needs. The connect door is the first
          // ask, and it ensures the row before it redirects.
          window.location.href = needsConsent
            ? `${API_URL}/api/integrations/mcp/connections/${connection.id}/reconsent`
            : `${API_URL}/api/integrations/mcp/built-ins/${provider}/connect`;
        }}
      >
        {loading
          ? "Loading"
          : readError
            ? "Retry"
            : connecting
              ? "Connecting"
              : needsConsent
                ? "Grant access"
                : connection
                  ? "Reconnect"
                  : "Add"}
      </AppButton>
    </McpTile>
  );
}
