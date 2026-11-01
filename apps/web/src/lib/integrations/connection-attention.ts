import {
  INTEGRATIONS,
  integrationConnectPath,
  mcpConnectionAuthorizePath,
  type McpConnectionAlert,
} from "@alfred/contracts";
import { useMemo } from "react";
import { API_URL } from "~/lib/eden";
import {
  useDeliveryAlerts,
  useGithubNeedsReconnect,
  useGoogleScopeGaps,
  useMcpConnectionAlerts,
} from "~/lib/integrations/use-integration-status";

/** One connection the user must repair. `key` is unique across every source of alerts. */
export interface ConnectionAttention {
  key: string;
  name: string;
  /** The fact that makes the repair necessary. */
  detail: string | null;
  actionLabel: string;
  /** The repair route on the API origin. Open it with `openAuthorizationTab`. */
  url: string;
}

/**
 * Every connection that needs the user, from the integration-status read (ADR-0100 amendment
 * 2026-11-01). The sidebar shows the count and the integrations page lists the items. The order:
 * missing Google scopes, the pre-App GitHub credential, stopped deliveries, then MCP connections.
 */
export function useConnectionAttention(): readonly ConnectionAttention[] {
  const scopeGaps = useGoogleScopeGaps();
  const github = useGithubNeedsReconnect();
  const deliveryAlerts = useDeliveryAlerts();
  const mcpAlerts = useMcpConnectionAlerts();

  return useMemo(() => {
    const items: ConnectionAttention[] = [];

    if (scopeGaps.connected && scopeGaps.missing.length > 0) {
      items.push({
        key: "google:scopes",
        name: "Google",
        detail: `A permission was left unchecked: ${joinNames(scopeGaps.missing.map((m) => m.name))}.`,
        actionLabel: "Reconnect",
        url: `${API_URL}${integrationConnectPath("gmail")}`,
      });
    }

    if (github.needsReconnect) {
      items.push({
        key: "github:app",
        name: github.accountLabel ? `GitHub (@${github.accountLabel})` : "GitHub",
        detail: "Alfred moved to a GitHub App. Reauthorize to read pull requests and activity.",
        actionLabel: "Reconnect",
        url: `${API_URL}${integrationConnectPath("github")}`,
      });
    }

    for (const alert of deliveryAlerts) {
      items.push({
        key: `integration:${alert.integration}`,
        name: INTEGRATIONS[alert.integration].displayName,
        detail: `Alfred stopped receiving activity. ${alert.reason}.`,
        actionLabel: "Reconnect",
        url: `${API_URL}${integrationConnectPath(alert.integration)}`,
      });
    }

    for (const alert of mcpAlerts) {
      items.push({
        key: `mcp:${alert.connectionId}`,
        name: alert.label,
        detail: mcpAlertDetail(alert),
        actionLabel: "Reconnect",
        url: `${API_URL}${mcpConnectionAuthorizePath(alert.connectionId)}`,
      });
    }

    return items;
  }, [scopeGaps, github, deliveryAlerts, mcpAlerts]);
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");

  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The most useful fact for one MCP alert. The server sends facts, not a sentence: a dead saved
 * sign-in first, then the missing scopes, then the connection's own last error.
 */
function mcpAlertDetail(alert: McpConnectionAlert): string | null {
  if (alert.credentialUnopenable) return "Its saved sign-in no longer opens.";

  if (alert.missingScopes.length > 0) {
    return `Missing permissions: ${alert.missingScopes.join(", ")}.`;
  }

  return alert.lastError;
}
