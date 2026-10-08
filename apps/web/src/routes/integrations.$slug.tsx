import { isCatalogSlug, isGoogleSlug, type GoogleSlug } from "@alfred/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { IntegrationDetailPage } from "./-integrations/detail/integration-detail-page";

/** Pre-registry ids had a `google_` prefix (ADR-0093); old links redirect to the bare slug. */
const LEGACY_GOOGLE_PREFIX = "google_";

function legacyPageTarget(id: string): GoogleSlug | undefined {
  if (!id.startsWith(LEGACY_GOOGLE_PREFIX)) return undefined;
  const slug = id.slice(LEGACY_GOOGLE_PREFIX.length);

  return isGoogleSlug(slug) ? slug : undefined;
}

/** Integration detail page. Sections live in routes/-integrations/detail. */
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
