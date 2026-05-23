import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "~/components/preview/integrations/back-link";
import { NotFound } from "~/components/preview/integrations/not-found";
import { ProviderDetail } from "~/components/preview/integrations/provider-detail";
import { getIntegrationProvider } from "~/lib/integrations";

/**
 * Visitors-now-grammar port of /integrations/$provider.
 *
 * Same IA + same data as the legacy detail page, rebuilt in visitors grammar:
 *   - Theme-aware (light + dark) via VsThemed
 *   - VsCard surfaces with `vs-elevated` shadows
 *   - Soft chip capabilities (matching dimension's chip cluster)
 *   - vs-card-in staggered entrance
 *
 * The page body lives in components/preview/integrations — each section
 * (header, hero, connected accounts, trust notice, related setup,
 * capabilities, overview) is its own module so each file exports a
 * single component.
 *
 * Compare:
 *   /integrations/$provider           → dimension grammar (dark, dense)
 *   /preview/integrations/$provider   → visitors-now grammar
 */
export const Route = createFileRoute("/preview/integrations/$provider")({
  component: PreviewIntegrationDetailPage,
});

function PreviewIntegrationDetailPage() {
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
