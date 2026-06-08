import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useGoogleScopeGaps } from "~/hooks/use-integration-status";
import { cn } from "~/lib/utils";

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
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-2.5",
        "border-b border-amber-500/20 bg-amber-500/10 text-amber-900",
      )}
      role="status"
    >
      <TriangleAlert size={16} className="shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1 text-[13px] leading-snug">
        Alfred can&apos;t access <span className="font-medium">{list}</span> — a permission was left
        unchecked when you connected Google.
      </p>
      <button
        type="button"
        onClick={() => {
          // Full-page redirect to the connect endpoint (no params → full grant);
          // Google merges the re-consent into the existing authorization.
          window.location.href = `${API_URL}/api/integrations/google/connect`;
        }}
        className={cn(
          "shrink-0 rounded-full px-3 py-1 text-[13px] font-medium",
          "bg-amber-600 text-white transition-colors hover:bg-amber-700",
        )}
      >
        Reconnect Google
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-full p-1 text-amber-700/70 transition-colors hover:text-amber-900"
        aria-label="Dismiss"
      >
        <X size={15} />
      </button>
    </div>
  );
}
