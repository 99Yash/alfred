import { useParams } from "@tanstack/react-router";
import { useResolvedIntegration } from "~/lib/integrations/use-integration-status";
import { BackLink } from "./back-link";
import { NotFound } from "./not-found";
import { ProviderDetail } from "./provider-detail";
import { getIntegrationProvider } from "~/lib/integrations/integrations";

export function IntegrationDetailPage() {
  const { provider: providerId } = useParams({ from: "/integrations/$provider" });
  const catalogProvider = getIntegrationProvider(providerId);
  // Resolve against the catalog's canonical id (`getIntegrationProvider`
  // accepts short slugs like `gmail`; the resolver only knows the
  // canonical id like `google_gmail`).
  const resolved = useResolvedIntegration(catalogProvider?.id ?? "");
  const provider = resolved ?? catalogProvider;

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-[700px] px-4 py-10 sm:px-6 sm:py-14">
        <BackLink />
        {provider ? <ProviderDetail provider={provider} /> : <NotFound />}
      </main>
    </div>
  );
}
