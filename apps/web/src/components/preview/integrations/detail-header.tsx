import { VsButton } from "~/components/ui/visitors";
import { IntegrationIcon } from "~/lib/integration-icons";
import type { IntegrationProvider } from "~/lib/integrations";

const API_URL =
  (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ??
  "http://localhost:3001";

/**
 * Provider id → API path that initiates the OAuth flow (with optional
 * `?features=` narrowing). Absent ids have no wired backend
 * (status: "soon") and the CTA renders disabled.
 *
 * Per-provider features:
 *  - Gmail → no `features` param: requests the full Gmail grant
 *    (briefing + triage + reply_draft) so every downstream workflow
 *    works without an extra re-consent.
 *  - Calendar → `?features=calendar`: ask only for calendar scopes so
 *    a Gmail-already-connected user sees a focused consent screen.
 *    Google's `include_granted_scopes=true` merges this into their
 *    existing grant.
 */
const CONNECT_PATHS: Readonly<Record<string, string>> = {
  google_gmail: "/api/integrations/google/connect",
  google_calendar: "/api/integrations/google/connect?features=calendar",
  github: "/api/integrations/github/connect",
};

export function DetailHeader({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
  const path = CONNECT_PATHS[provider.id];
  const wired = Boolean(path);
  const label = connected ? "Add Account" : wired ? "Connect" : "Coming Soon";

  const onConnect = wired
    ? () => {
        window.location.href = `${API_URL}${path}`;
      }
    : undefined;

  return (
    <header className="flex items-start justify-between gap-4 vs-card-in">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationIcon
          brand={provider.brand}
          size="md"
          connected={connected}
          title={provider.name}
        />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-base font-medium text-vs-fg-4 tracking-tight">{provider.name}</h1>
          <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">{provider.description}</p>
        </div>
      </div>
      <VsButton variant="white" size="lg" disabled={!wired} onClick={onConnect}>
        {label}
      </VsButton>
    </header>
  );
}
