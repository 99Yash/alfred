import { AppButton, AppCard } from "~/components/ui/v2";
import type { ConnectedAccount } from "~/hooks/use-integration-status";
import type { IntegrationProvider } from "~/lib/integrations";
import { ColumnLabel } from "./column-label";
import { SectionHeading } from "./section-heading";

interface ResolvedIntegrationLike extends IntegrationProvider {
  connectedAccounts?: ReadonlyArray<ConnectedAccount>;
}

export function ConnectedAccounts({
  provider,
  connected,
}: {
  provider: ResolvedIntegrationLike;
  connected: boolean;
}) {
  const accounts = provider.connectedAccounts ?? [];

  return (
    <section className="space-y-3 app-card-in" style={{ animationDelay: "120ms" }}>
      <SectionHeading>Connected</SectionHeading>

      <AppCard padded={false} className="overflow-hidden">
        <div className="grid grid-cols-3 gap-4 px-4 pt-3 pb-2 border-b border-app-bg-3/60">
          <ColumnLabel>Account</ColumnLabel>
          <ColumnLabel>Date</ColumnLabel>
          <ColumnLabel>Status</ColumnLabel>
        </div>

        {connected && accounts.length > 0 ? (
          accounts.map((acct) => (
            <div key={acct.accountLabel} className="grid grid-cols-3 items-center gap-4 px-4 py-3">
              <p className="min-w-0 truncate text-sm text-app-fg-4 font-medium">
                {acct.accountLabel}
              </p>
              <p className="text-sm text-app-fg-3 tabular-nums">
                {formatConnectedDate(acct.connectedAt)}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm text-app-fg-3">
                  <span className="size-1.5 rounded-full bg-app-green-4" aria-hidden />
                  Active
                </span>
                <AppButton variant="ghost" size="sm">
                  Disconnect
                </AppButton>
              </div>
            </div>
          ))
        ) : (
          <div className="p-4 text-[12.5px] text-app-fg-2">No account connected yet.</div>
        )}
      </AppCard>
    </section>
  );
}

function formatConnectedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
