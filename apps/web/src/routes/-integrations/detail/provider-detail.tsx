import { isInboundEventSource, isLiveProviderSlug } from "@alfred/contracts";
import type { IntegrationPage } from "~/lib/integrations/integrations";
import { Capabilities } from "./capabilities";
import { ConnectedAccounts } from "./connected-accounts";
import { DesignOnlyNotice } from "./design-only-notice";
import { DetailHeader } from "./detail-header";
import { HeroPanel } from "./hero-panel";
import { Overview } from "./overview";
import { ProviderPolicy } from "./provider-policy";
import { RawKinds } from "./raw-kinds";
import { RelatedSetup } from "./related-setup";
import { TrustNotice } from "./trust-notice";

export function ProviderDetail({ provider }: { provider: IntegrationPage }) {
  const connected = provider.status === "connected";
  // A planned provider has no route, no tools, and no credential, so its
  // connection, policy, and capability surfaces would be phantom. Render the
  // design-only notice instead of them; the header and hero stay for context.
  const live = isLiveProviderSlug(provider.slug);

  return (
    <div className="mt-6 space-y-10">
      <DetailHeader provider={provider} connected={connected} />
      <HeroPanel provider={provider} />
      {live ? (
        <>
          <ConnectedAccounts provider={provider} connected={connected} />
          <ProviderPolicy provider={provider} />
          <TrustNotice provider={provider} />
          <RelatedSetup provider={provider} />
          <Capabilities provider={provider} />
          {isInboundEventSource(provider.slug) && <RawKinds slug={provider.slug} />}
        </>
      ) : (
        <DesignOnlyNotice name={provider.name} />
      )}
      <Overview provider={provider} />
    </div>
  );
}
