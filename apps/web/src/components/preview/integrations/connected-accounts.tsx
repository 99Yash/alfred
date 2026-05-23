import { VsButton, VsCard } from "~/components/ui/visitors";
import type { IntegrationProvider } from "~/lib/integrations";
import { ColumnLabel } from "./column-label";
import { SectionHeading } from "./section-heading";

const MOCK_CONNECTED_DATE = "March 15, 2026";

const MOCK_ACCOUNT_FOR_BRAND: Record<IntegrationProvider["brand"], string> = {
  collaborators: "—",
  github: "99Yash",
  gmail: "yashgourav@gmail.com",
  google_calendar: "yashgourav@gmail.com",
  google_drive: "yashgourav@gmail.com",
  google_docs: "yashgourav@gmail.com",
  google_sheets: "yashgourav@gmail.com",
  google_slides: "yashgourav@gmail.com",
  linear: "yash@oliv.ai",
  slack: "Alfred workspace",
  web: "—",
};

export function ConnectedAccounts({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: "120ms" }}>
      <SectionHeading>Connected</SectionHeading>

      <VsCard padded={false} className="overflow-hidden">
        <div className="grid grid-cols-3 gap-4 px-4 pt-3 pb-2 border-b border-vs-bg-3/60">
          <ColumnLabel>Account</ColumnLabel>
          <ColumnLabel>Date</ColumnLabel>
          <ColumnLabel>Status</ColumnLabel>
        </div>

        {connected ? (
          <div className="grid grid-cols-3 items-center gap-4 px-4 py-3">
            <p className="min-w-0 truncate text-sm text-vs-fg-4 font-medium">
              {MOCK_ACCOUNT_FOR_BRAND[provider.brand]}
            </p>
            <p className="text-sm text-vs-fg-3 tabular-nums">{MOCK_CONNECTED_DATE}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm text-vs-fg-3">
                <span className="size-1.5 rounded-full bg-vs-green-4" aria-hidden />
                Active
              </span>
              <VsButton variant="ghost" size="sm">
                Disconnect
              </VsButton>
            </div>
          </div>
        ) : (
          <div className="px-4 py-4 text-[12.5px] text-vs-fg-2">No account connected yet.</div>
        )}
      </VsCard>
    </section>
  );
}
