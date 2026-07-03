import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { IntegrationDetailPage } from "./-integration-detail/integration-detail-page";

/**
 * App-grammar port of /integrations/$provider.
 *
 * Same IA + same data as the legacy detail page, rebuilt in app grammar:
 *   - Theme-aware (light + dark) via AppThemed
 *   - AppCard surfaces with `app-elevated` shadows
 *   - Soft chip capabilities (matching dimension's chip cluster)
 *   - app-card-in staggered entrance
 *
 * The page body lives in components/integrations — each section
 * (header, hero, connected accounts, trust notice, related setup,
 * capabilities, overview) is its own module so each file exports a
 * single component.
 *
 * Compare:
 *   /integrations/$provider           → dimension grammar (dark, dense)
 *   /integrations/$provider   → app grammar
 */
export const Route = createFileRoute("/integrations/$provider")({
  head: ({ params }) =>
    pageMeta({
      title: `${params.provider} · Integrations`,
      path: `/integrations/${encodeURIComponent(params.provider)}`,
    }),
  component: IntegrationDetailPage,
});
