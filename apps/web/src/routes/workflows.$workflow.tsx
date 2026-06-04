import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewWorkflowDetailPage } from "./-preview-workflows-detail/preview-workflow-detail-page";

/**
 * Visitors-now-grammar port of `/workflows/$workflow`.
 *
 * Same data + same IA as the original detail page (header → tabs →
 * Plan/History/Approvals), rebuilt on VsCard + VsButton + VsSegmented.
 * The page scrolls inside the shared preview shell; sidebar + theme +
 * cmd-K live in `preview.tsx`.
 *
 * Compare:
 *   /workflows/$workflow            → dimension grammar
 *   /preview/workflows/$workflow    → visitors-now grammar
 */
export const Route = createFileRoute("/workflows/$workflow")({
  head: ({ params }) => pageMeta({ title: `${params.workflow} · Workflows` }),
  component: PreviewWorkflowDetailPage,
});
