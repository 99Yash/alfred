import type { IntegrationProvider } from "~/lib/integrations";
import { Capabilities } from "./capabilities";
import { ConnectedAccounts } from "./connected-accounts";
import { DetailHeader } from "./detail-header";
import { HeroPreview } from "./hero-preview";
import { Overview } from "./overview";
import { RelatedSetup } from "./related-setup";
import { TrustNotice } from "./trust-notice";

export function ProviderDetail({ provider }: { provider: IntegrationProvider }) {
  const connected = provider.status === "connected";

  return (
    <div className="mt-6 space-y-10">
      <DetailHeader provider={provider} connected={connected} />
      <HeroPreview provider={provider} />
      <ConnectedAccounts provider={provider} connected={connected} />
      <TrustNotice provider={provider} />
      <RelatedSetup provider={provider} />
      <Capabilities provider={provider} />
      <Overview provider={provider} />
    </div>
  );
}
