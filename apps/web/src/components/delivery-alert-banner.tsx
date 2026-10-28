import {
  INTEGRATIONS,
  integrationConnectPath,
  mcpConnectionAuthorizePath,
  type McpConnectionAlert,
} from "@alfred/contracts";
import { useState, type ReactNode } from "react";
import { NagBanner } from "~/components/nag-banner";
import { API_URL } from "~/lib/eden";
import {
  useDeliveryAlerts,
  useMcpConnectionAlerts,
} from "~/lib/integrations/use-integration-status";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";

/** One card, from either list. `key` is unique across both, so a dismissal hides one card. */
interface BannerCard {
  key: string;
  message: ReactNode;
  actionLabel: string;
  url: string;
}

/**
 * Nag bar for an integration that stopped delivering events (ADR-0100), or an MCP connection
 * that Alfred cannot use (ADR-0100 amendment 2026-10-28, item 4). A broken source sends nothing,
 * which looks like a quiet week. Provider-agnostic: names and routes come from the alert.
 * One card at a time; delivery alerts come first.
 */
export function DeliveryAlertBanner() {
  const deliveryAlerts = useDeliveryAlerts();
  const mcpAlerts = useMcpConnectionAlerts();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const deliveryCards = deliveryAlerts.map((alert): BannerCard => {
    const name = INTEGRATIONS[alert.integration].displayName;

    return {
      key: `integration:${alert.integration}`,
      message: (
        <>
          Alfred stopped receiving <span className="font-medium">{name}</span> activity.{" "}
          {alert.reason}.
        </>
      ),
      actionLabel: `Reconnect ${name}`,
      url: `${API_URL}${integrationConnectPath(alert.integration)}`,
    };
  });

  const mcpCards = mcpAlerts.map(
    (alert): BannerCard => ({
      key: `mcp:${alert.connectionId}`,
      message: (
        <>
          Alfred cannot use <span className="font-medium">{alert.label}</span>.{" "}
          {mcpAlertDetail(alert)}
        </>
      ),
      actionLabel: `Reconnect ${alert.label}`,
      url: `${API_URL}${mcpConnectionAuthorizePath(alert.connectionId)}`,
    }),
  );

  const card = [...deliveryCards, ...mcpCards].find((entry) => !dismissed.includes(entry.key));

  if (!card) return null;

  return (
    <NagBanner
      message={card.message}
      actionLabel={card.actionLabel}
      onAction={() => {
        // New tab; the status read refetches on focus, so the alert clears on return.
        openAuthorizationTab(card.url);
      }}
      onDismiss={() => setDismissed((prev) => [...prev, card.key])}
    />
  );
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
