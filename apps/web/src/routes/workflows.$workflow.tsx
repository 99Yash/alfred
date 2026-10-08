import { getStringPath } from "@alfred/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { WorkflowDetailPage } from "./-workflows-detail/workflow-detail-page";

/** Workflow detail: header, then Plan, History, and Approvals tabs. */
export const Route = createFileRoute("/workflows/$workflow")({
  validateSearch: (params: unknown) => {
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
