import { useState } from "react";
import { NagBanner } from "~/components/nag-banner";
import { useGithubNeedsReconnect } from "~/lib/integrations/use-integration-status";
import { API_URL } from "~/lib/eden";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";

/**
 * Nag bar for GitHub credentials from before the GitHub App (ADR-0052): active
 * but with no `installation_id`, so PR tools and webhooks fail. Reconnect installs the app.
 */
export function GithubReconnectBanner() {
  const { needsReconnect, accountLabel } = useGithubNeedsReconnect();
  const [dismissed, setDismissed] = useState(false);

  if (!needsReconnect || dismissed) return null;

  return (
    <NagBanner
      message={
        <>
          Reconnect GitHub
          {accountLabel ? <span className="font-medium"> (@{accountLabel})</span> : null}: Alfred
          moved to a GitHub App and needs you to reauthorize before it can read pull requests or
          track activity.
        </>
      }
      actionLabel="Reconnect GitHub"
      onAction={() => {
        // New tab; the status read refetches on focus, so the nag clears on return.
        openAuthorizationTab(`${API_URL}/api/integrations/github/connect`);
      }}
      onDismiss={() => setDismissed(true)}
    />
  );
}
