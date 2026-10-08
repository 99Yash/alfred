import { credentialProviderOf, INTEGRATIONS, integrationRoutePrefix } from "@alfred/contracts";
import { useState } from "react";
import { NagBanner } from "~/components/nag-banner";
import { API_URL } from "~/lib/eden";
import { useDeliveryAlerts } from "~/lib/integrations/use-integration-status";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";

/**
 * Nag bar for an integration that stopped delivering events (ADR-0100). A broken
 * source sends nothing, which looks like a quiet week. Provider-agnostic: name and
 * connect route come from the verdict's slug. One card at a time.
 */
export function DeliveryAlertBanner() {
  const alerts = useDeliveryAlerts();
  const [dismissed, setDismissed] = useState<readonly string[]>([]);

  const alert = alerts.find((entry) => !dismissed.includes(entry.integration));

  if (!alert) return null;

  const name = INTEGRATIONS[alert.integration].displayName;

  return (
    <NagBanner
      message={
        <>
          Alfred stopped receiving <span className="font-medium">{name}</span> activity.{" "}
          {alert.reason}.
        </>
      }
      actionLabel={`Reconnect ${name}`}
      onAction={() => {
        // New tab; the status read refetches on focus, so the alert clears on return.
        const prefix = integrationRoutePrefix(credentialProviderOf(alert.integration));
        openAuthorizationTab(`${API_URL}${prefix}/connect`);
      }}
      onDismiss={() => setDismissed((prev) => [...prev, alert.integration])}
    />
  );
}
