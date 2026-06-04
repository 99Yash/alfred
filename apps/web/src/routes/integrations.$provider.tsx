import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewIntegrationDetailPage } from "./-preview-integration-detail/preview-integration-detail-page";

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
export const Route = createFileRoute("/integrations/$provider")({
  head: ({ params }) => pageMeta({ title: `${params.provider} · Integrations` }),
  component: PreviewIntegrationDetailPage,
});
