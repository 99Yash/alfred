import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { PreviewWorkflowsPage } from "./-preview-workflows/preview-workflows-page";

/**
 * Visitors-now-grammar port of /workflows.
 *
 * Same data + same IA as the original (centered hero, built-ins grid,
 * empty "Your workflows" state), but rebuilt on VsCard + VsButton with a
 * per-workflow visual hero — each card shows a stylized preview of what
 * the workflow produces (stacked email rows for briefing, label chips for
 * triage, fact cards for research) instead of a flat icon-tile.
 *
 * Theme: defaults to system preference, override-able via the toggle
 * in the top-right.
 *
 * Compare:
 *   /workflows            → dimension grammar (dark, gradient title, frost tile)
 *   /preview/workflows    → visitors-now grammar (theme-aware, hero previews)
 */
export const Route = createFileRoute("/preview/workflows")({
  component: PreviewWorkflowsRoute,
});

function PreviewWorkflowsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewWorkflowsPage />;
}
