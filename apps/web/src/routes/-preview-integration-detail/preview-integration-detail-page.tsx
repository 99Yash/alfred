import { BackLink } from "~/components/preview/integrations/back-link";
import { NotFound } from "~/components/preview/integrations/not-found";
import { ProviderDetail } from "~/components/preview/integrations/provider-detail";
import { getIntegrationProvider } from "~/lib/integrations";
import { Route } from "~/routes/preview.integrations.$provider";

export function PreviewIntegrationDetailPage() {
  const { provider: providerId } = Route.useParams();
  const provider = getIntegrationProvider(providerId);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-[700px] px-4 sm:px-6 py-10 sm:py-14">
        <BackLink />
        {provider ? <ProviderDetail provider={provider} /> : <NotFound />}
      </main>
    </div>
  );
}
