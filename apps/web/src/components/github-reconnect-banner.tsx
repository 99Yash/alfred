import { useState } from "react";
import { NagBanner } from "~/components/nag-banner";
import { useGithubNeedsReconnect } from "~/lib/integrations/use-integration-status";
import { API_URL } from "~/lib/eden";
import { openAuthorizationTab } from "~/lib/integrations/authorization-tab";

/**
 * Slim nag bar for accounts connected to GitHub before the GitHub App
 * migration (ADR-0052). Their credential is still `active` but has no
 * `installation_id`, so the PR tools and activity webhooks don't work.
 * Reconnecting runs the one-click Install & Authorize, which writes the
 * installation id. Renders nothing once a healthy installation exists.
 * Sibling of `ScopeGapBanner`.
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
        // Authorization opens in a new tab; the banner's status read
        // refetches on window focus, so the nag clears on return.
        openAuthorizationTab(`${API_URL}/api/integrations/github/connect`);
      }}
      onDismiss={() => setDismissed(true)}
    />
  );
}
