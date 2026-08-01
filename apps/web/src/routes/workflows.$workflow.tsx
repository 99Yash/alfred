import { getStringPath } from "@alfred/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { WorkflowDetailPage } from "./-workflows-detail/workflow-detail-page";

/**
 * App-grammar port of `/workflows/$workflow`.
 *
 * Same data + same IA as the original detail page (header → tabs →
 * Plan/History/Approvals), rebuilt on AppCard + AppButton + AppSegmented.
 * The page scrolls inside the shared preview shell; sidebar + theme +
 * cmd-K live in the shared preview layout.
 *
 * Compare:
 *   /workflows/$workflow            → dimension grammar
 *   /preview/workflows/$workflow    → app grammar
 */
export const Route = createFileRoute("/workflows/$workflow")({
  validateSearch: (params: Record<string, unknown>) => {
    const workflowRecovery = getStringPath(params, "workflow_recovery");
    const revisionId = getStringPath(params, "revision_id");
    return {
      ...(workflowRecovery ? { workflow_recovery: workflowRecovery } : {}),
      ...(revisionId ? { revision_id: revisionId } : {}),
    };
  },
  head: ({ params }) =>
    pageMeta({
      title: `${params.workflow} · Workflows`,
      path: `/workflows/${encodeURIComponent(params.workflow)}`,
    }),
  component: WorkflowDetailPage,
});
