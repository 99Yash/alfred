import type { IntegrationProvider } from "~/lib/integrations/integrations";
import { Capabilities } from "./capabilities";
import { ConnectedAccounts } from "./connected-accounts";
import { DetailHeader } from "./detail-header";
import { HeroPanel } from "./hero-panel";
import { Overview } from "./overview";
import { ProviderPolicy } from "./provider-policy";
import { RelatedSetup } from "./related-setup";
import { TrustNotice } from "./trust-notice";

export function ProviderDetail({ provider }: { provider: IntegrationProvider }) {
  const connected = provider.status === "connected";

  return (
    <div className="mt-6 space-y-10">
      <DetailHeader provider={provider} connected={connected} />
      <HeroPanel provider={provider} />
      <ConnectedAccounts provider={provider} connected={connected} />
      <ProviderPolicy provider={provider} />
      <TrustNotice provider={provider} />
      <RelatedSetup provider={provider} />
      <Capabilities provider={provider} />
      <Overview provider={provider} />
    </div>
  );
}
