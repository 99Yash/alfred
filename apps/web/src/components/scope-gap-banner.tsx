import { useState } from "react";
import { NagBanner } from "~/components/nag-banner";
import { useGoogleScopeGaps } from "~/lib/integrations/use-integration-status";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "http://localhost:3001";

/**
 * Slim nag bar shown when a Google account is connected but some scopes were
 * left unchecked on the consent screen (the common failure mode of a broad
 * one-click grant). Reconnecting re-runs the full grant; Google merges it into
 * the existing authorization via `include_granted_scopes=true`. Renders nothing
 * when there's no gap. Borrowed from dimension's scope-completeness banner.
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
        // Full-page redirect to the connect endpoint (no params → full grant);
        // Google merges the re-consent into the existing authorization.
        window.location.href = `${API_URL}/api/integrations/google/connect`;
      }}
      onDismiss={() => setDismissed(true)}
    />
  );
}
