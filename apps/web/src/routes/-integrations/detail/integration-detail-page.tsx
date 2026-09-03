import { useParams } from "@tanstack/react-router";
import { useResolvedIntegration } from "~/lib/integrations/use-integration-status";
import { BackLink } from "./back-link";
import { NotFound } from "./not-found";
import { ProviderDetail } from "./provider-detail";
import { getIntegrationPage } from "~/lib/integrations/integrations";

export function IntegrationDetailPage() {
  const { slug } = useParams({ from: "/integrations/$slug" });
  // The route's `beforeLoad` redirects the legacy `google_*` ids, so a param
  // that is not a catalog slug here is a genuine miss.
  const page = getIntegrationPage(slug);
  const resolved = useResolvedIntegration(slug);
  const provider = resolved ?? page;

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-[700px] px-4 py-10 sm:px-6 sm:py-14">
        <BackLink />
        {provider ? <ProviderDetail provider={provider} /> : <NotFound />}
      </main>
    </div>
  );
}
