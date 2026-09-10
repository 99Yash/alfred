import { credentialProviderOf, INTEGRATIONS, integrationRoutePrefix } from "@alfred/contracts";
import { useState } from "react";
import { NagBanner } from "~/components/nag-banner";
import { API_URL } from "~/lib/eden";
import { useDeliveryAlerts } from "~/lib/integrations/use-integration-status";

/**
 * Nag bar for an integration that stopped delivering events (ADR-0100).
 *
 * A source that produces events only while it is healthy sends nothing when it
 * breaks, so nothing arrives for the app to react to and the silence looks
 * exactly like a quiet week. The server pulls each source's own health verdict
 * on the same read that builds every integration tile; this card is where that
 * verdict meets the button that fixes it.
 *
 * Generic on purpose. It names no provider: the display name and the connect
 * route both come from the integration slug the verdict carried, so a new
 * source reaches this banner with no edit here. Sibling of `ScopeGapBanner` and
 * `GithubReconnectBanner`, which nag about a credential rather than a delivery.
 *
 * One card at a time. Two alerts are two separate repairs, and stacking them
 * turns a notice into a list; the second appears once the first is resolved or
 * dismissed.
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
        // Full-page redirect to the provider's connect endpoint, as both
        // siblings do. The alert's whole claim is that this integration needs
        // reconnecting, so sending the user to a page to press one more button
        // adds a step and no information.
        const prefix = integrationRoutePrefix(credentialProviderOf(alert.integration));
        window.location.href = `${API_URL}${prefix}/connect`;
      }}
      onDismiss={() => setDismissed((prev) => [...prev, alert.integration])}
    />
  );
}
