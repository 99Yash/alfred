import { useState } from "react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { useDisconnectIntegration, type ConnectedAccount } from "~/hooks/use-integration-status";
import {
  PROVIDER_BACKEND,
  type IntegrationBackend,
  type IntegrationProvider,
} from "~/lib/integrations/integrations";
import { toast } from "~/lib/toast";
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
  const backend = PROVIDER_BACKEND[provider.id];

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
            <div key={acct.id} className="grid grid-cols-3 items-center gap-4 px-4 py-3">
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
                {backend ? (
                  <DisconnectControl
                    backend={backend}
                    account={acct}
                    isGoogle={backend === "google"}
                  />
                ) : null}
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

/**
 * Two-step inline disconnect: the first click arms a Cancel / Confirm pair in
 * place (no modal — matches the low-friction connect flows), the second runs
 * the delete. Google is special-cased because one credential backs every
 * google_* tile, so disconnecting drops the whole Workspace grant — the armed
 * state spells that out.
 */
function DisconnectControl({
  backend,
  account,
  isGoogle,
}: {
  backend: IntegrationBackend;
  account: ConnectedAccount;
  isGoogle: boolean;
}) {
  const { mutateAsync, isPending } = useDisconnectIntegration(backend);
  const [armed, setArmed] = useState(false);

  async function disconnect() {
    try {
      await mutateAsync(account.id);
      toast.success(`Disconnected ${account.accountLabel}`);
      setArmed(false);
    } catch {
      toast.error("Couldn't disconnect — try again");
    }
  }

  if (!armed) {
    return (
      <AppButton variant="ghost" size="sm" onClick={() => setArmed(true)}>
        Disconnect
      </AppButton>
    );
  }

  return (
    <div role="alert" className="flex min-w-0 items-center justify-end gap-1.5">
      {isGoogle ? (
        <span className="truncate text-[11px] text-app-fg-2">Removes all Google access</span>
      ) : null}
      <AppButton
        variant="ghost"
        size="sm"
        onClick={() => setArmed(false)}
        disabled={isPending}
        autoFocus
      >
        Cancel
      </AppButton>
      <AppButton
        variant="destructive"
        size="sm"
        loading={isPending}
        onClick={() => void disconnect()}
      >
        {isPending ? "Disconnecting…" : "Confirm"}
      </AppButton>
    </div>
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
