import { VsButton } from "~/components/ui/visitors";
import { IntegrationIcon } from "~/lib/integration-icons";
import type { IntegrationProvider } from "~/lib/integrations";

export function DetailHeader({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
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
      <VsButton variant="white" size="lg">
        {connected ? "Add Account" : "Connect"}
      </VsButton>
    </header>
  );
}
