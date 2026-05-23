import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewIntegrationsPage } from "./-preview-integrations/preview-integrations-page";

/**
 * Visitors-now-grammar port of /integrations.
 *
 * Same IA + same data (CATEGORY_ORDER, INTEGRATION_PROVIDERS), rebuilt
 * with the visitors-now primitives. Adds:
 *   - A 3-tile floating hero showing connected provider logos (the
 *     "logos as a hero" treatment Yash called out, ported from the
 *     dimension integration detail page's HeroPreview).
 *   - VsCard rows with hue-aware status pills.
 *   - Connected-provider green status dot on the icon tile.
 *   - Staggered card entrance.
 *
 * Compare:
 *   /integrations           → dimension grammar (dark, dense row layout)
 *   /preview/integrations   → visitors-now grammar (theme-aware, hero, soft chips)
 */
export const Route = createFileRoute("/preview/integrations")({
  component: PreviewIntegrationsRoute,
});

function PreviewIntegrationsRoute() {
  // Defer to the child route when one is matched (e.g. /preview/integrations/$provider).
  // Without this, TanStack's flat-routes nesting renders the list as the
  // shared parent layout even on the detail URL. Mirrors `integrations.tsx`.
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewIntegrationsPage />;
}
