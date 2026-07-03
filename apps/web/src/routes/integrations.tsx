import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { IntegrationsRoute } from "./-integrations/integrations-route";

/**
 * App-grammar port of /integrations.
 *
 * Same IA + same data (CATEGORY_ORDER, INTEGRATION_PROVIDERS), rebuilt
 * with the app primitives. Adds:
 *   - A 3-tile floating hero showing connected provider logos (the
 *     "logos as a hero" treatment Yash called out, ported from the
 *     dimension integration detail page's HeroPanel).
 *   - AppCard rows with hue-aware status pills.
 *   - Connected-provider green status dot on the icon tile.
 *   - Staggered card entrance.
 *
 * Compare:
 *   /integrations           → dimension grammar (dark, dense row layout)
 *   /integrations   → app grammar (theme-aware, hero, soft chips)
 */
export const Route = createFileRoute("/integrations")({
  head: () => pageMeta({ title: "Integrations", path: "/integrations" }),
  component: IntegrationsRoute,
});
