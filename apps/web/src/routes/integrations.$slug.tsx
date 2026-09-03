import { isCatalogSlug, isGoogleSlug, type GoogleSlug } from "@alfred/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { IntegrationDetailPage } from "./-integrations/detail/integration-detail-page";

/**
 * The catalog id the web keyed its pages on before the integration registry
 * (ADR-0093) was the slug with a `google_` prefix on the Google products
 * (`google_gmail`). The slug is the only key now, so a bookmarked or mailed
 * `/integrations/google_gmail` lands on `/integrations/gmail`. This is the
 * last home of the catalog id; it is deleted one release after the registry's
 * PR 3.
 */
const LEGACY_GOOGLE_PREFIX = "google_";

function legacyPageTarget(id: string): GoogleSlug | undefined {
  if (!id.startsWith(LEGACY_GOOGLE_PREFIX)) return undefined;
  const slug = id.slice(LEGACY_GOOGLE_PREFIX.length);
  return isGoogleSlug(slug) ? slug : undefined;
}

/**
 * App-grammar port of /integrations/$slug.
 *
 * Same IA + same data as the legacy detail page, rebuilt in app grammar:
 *   - Theme-aware (light + dark) via AppThemed
 *   - AppCard surfaces with `app-elevated` shadows
 *   - Soft chip capabilities (matching dimension's chip cluster)
 *   - app-card-in staggered entrance
 *
 * The page body lives in routes/-integrations/detail — each section
 * (header, hero, connected accounts, trust notice, related setup,
 * capabilities, overview) is its own module so each file exports a
 * single component.
 */
export const Route = createFileRoute("/integrations/$slug")({
  beforeLoad: ({ params }) => {
    if (isCatalogSlug(params.slug)) return;
    const target = legacyPageTarget(params.slug);
    if (target) {
      throw redirect({ to: "/integrations/$slug", params: { slug: target }, replace: true });
    }
  },
  head: ({ params }) =>
    pageMeta({
      title: `${params.slug} · Integrations`,
      path: `/integrations/${encodeURIComponent(params.slug)}`,
    }),
  component: IntegrationDetailPage,
});
