import { integrationRoutePrefix } from "@alfred/contracts";
import { useState } from "react";
import { NagBanner } from "~/components/nag-banner";
import { useGoogleScopeGaps } from "~/lib/integrations/use-integration-status";
import { API_URL } from "~/lib/eden";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";

/**
 * Nag bar when Google scopes were left unchecked at consent. Reconnect re-runs
 * the full grant; `include_granted_scopes=true` merges it.
 */
export function ScopeGapBanner() {
  const { connected, missing } = useGoogleScopeGaps();
  const [dismissed, setDismissed] = useState(false);

  if (!connected || missing.length === 0 || dismissed) return null;

  const names = missing.map((m) => m.name);

  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  return (
    <NagBanner
      message={
        <>
          Alfred can&apos;t access <span className="font-medium">{list}</span>: a permission was
          left unchecked when you connected Google.
        </>
      }
      actionLabel="Reconnect Google"
      onAction={() => {
        // New tab; the status read refetches on focus, so the nag clears on return.
        openAuthorizationTab(`${API_URL}${integrationRoutePrefix("google")}/connect`);
      }}
      onDismiss={() => setDismissed(true)}
    />
  );
}
