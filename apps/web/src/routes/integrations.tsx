import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewIntegrationsRoute } from "./-preview-integrations/preview-integrations-route";

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
export const Route = createFileRoute("/integrations")({
  head: () => pageMeta({ title: "Integrations", path: "/integrations" }),
  component: PreviewIntegrationsRoute,
});
