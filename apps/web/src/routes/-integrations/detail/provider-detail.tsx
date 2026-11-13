import { builtInMCPProvidersOf, isInboundEventSource, isLiveProviderSlug } from "@alfred/contracts";
import type { IntegrationPage } from "~/lib/integrations/integrations";
import { Capabilities } from "./capabilities";
import { ConnectedAccounts } from "./connected-accounts";
import { DesignOnlyNotice } from "./design-only-notice";
import { DetailHeader } from "./detail-header";
import { HeroPanel } from "./hero-panel";
import { McpConnectionPanel } from "./mcp-connection-panel";
import { Overview } from "./overview";
import { ProviderPolicy } from "./provider-policy";
import { RawKinds } from "./raw-kinds";
import { RelatedSetup } from "./related-setup";
import { TrustNotice } from "./trust-notice";

export function ProviderDetail({ provider }: { provider: IntegrationPage }) {
  const connected = provider.status === "connected";
  // A planned provider has no Alfred credential. One with a built-in MCP server shows
  // that connection; any other shows the design-only notice.
  const live = isLiveProviderSlug(provider.slug);
  const builtIns = builtInMCPProvidersOf(provider.slug);

  return (
    <div className="mt-6 space-y-10">
      <DetailHeader provider={provider} connected={connected} />
      <HeroPanel provider={provider} />
      {live ? (
        <>
          <ConnectedAccounts provider={provider} connected={connected} />
          {/* GitHub: the install also connects its MCP server, so the page shows both halves. */}
          {builtIns.map((builtIn) => (
            <McpConnectionPanel
              key={builtIn}
              provider={builtIn}
              note={`Connecting ${provider.name} also connects this server. Chat reads ${provider.name} through it.`}
            />
          ))}
          <ProviderPolicy provider={provider} />
          <TrustNotice provider={provider} />
          <RelatedSetup provider={provider} />
          <Capabilities provider={provider} />
          {isInboundEventSource(provider.slug) && <RawKinds slug={provider.slug} />}
        </>
      ) : builtIns.length > 0 ? (
        builtIns.map((builtIn) => (
          <McpConnectionPanel
            key={builtIn}
            provider={builtIn}
            note={`${provider.name} connects only through its MCP server. Each call waits for your approval before it runs.`}
          />
        ))
      ) : (
        <DesignOnlyNotice name={provider.name} />
      )}
      <Overview provider={provider} />
    </div>
  );
}
