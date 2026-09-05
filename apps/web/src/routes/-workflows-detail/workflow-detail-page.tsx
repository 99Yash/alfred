import { useParams, useSearch } from "@tanstack/react-router";
import { MoreHorizontal, Pause, Play, Share2 } from "lucide-react";
import { useState } from "react";
import { AppButton, AppCard, AppSegmented } from "~/components/ui/v2";
import { useWorkflow } from "~/lib/replicache/use-workflows";
import { syncedWorkflowToView } from "~/routes/-workflows/workflows-utils";
import { ApprovalsTab } from "./approvals-tab";
import { BackLink } from "./back-link";
import { DetailShell } from "./detail-shell";
import { HistoryTab } from "./history-tab";
import { PlanTab } from "./plan-tab";
import { RecoveryPanel } from "./recovery-panel";
import { ShareDialog } from "./share-dialog";

type WorkflowTab = "plan" | "history" | "approvals";

const TABS = [
  { value: "plan" as const, label: "Plan" },
  { value: "history" as const, label: "History" },
  { value: "approvals" as const, label: "Approvals" },
];

const SHARE_LEADING = <Share2 size={14} />;
const PAUSE_LEADING = <Pause size={14} />;
const PLAY_LEADING = <Play size={14} />;

export function WorkflowDetailPage() {
  const { workflow: slug } = useParams({ from: "/workflows/$workflow" });
  const { workflow_recovery, revision_id } = useSearch({ from: "/workflows/$workflow" });
  const { workflow, updateWorkflow, loading } = useWorkflow(slug);
  const [tab, setTab] = useState<WorkflowTab>("plan");
  const [shareOpen, setShareOpen] = useState(false);

  if (!workflow) {
    return (
      <DetailShell>
        <BackLink />
        <AppCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-app-fg-4">
            {loading ? "Loading workflow…" : "Workflow not found"}
          </p>
          {!loading ? (
            <p className="max-w-md text-xs leading-5 text-app-fg-3">
              No workflow with this slug is synced to this device.
            </p>
          ) : null}
        </AppCard>
      </DetailShell>
    );
  }

  const view = syncedWorkflowToView(workflow);
  const active = workflow.status === "active";
  const hasUnpublishedChanges =
    workflow.currentRevisionId !== null &&
    workflow.currentRevisionId !== workflow.publishedRevisionId;

  const pauseWorkflow = () => {
    if (active) void updateWorkflow({ status: "paused" });
  };

  return (
    <DetailShell>
      <BackLink />

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[32px] leading-[38px] font-medium tracking-tight text-app-fg-4">
            {workflow.name}
          </h1>
          {workflow.description ? (
            <p className="mt-1 max-w-xl text-sm leading-5 text-app-fg-3">{workflow.description}</p>
          ) : null}
          {hasUnpublishedChanges ? (
            <p className="mt-2 text-xs font-medium text-app-fg-3">
              This workflow has unpublished changes.
            </p>
          ) : null}
          {workflow.blocked ? (
            <p className="mt-2 max-w-xl text-xs leading-5 text-rose-600">
              {workflow.blocked.message}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <AppButton variant="ghost" size="md" aria-label="More workflow actions">
            <MoreHorizontal size={16} />
          </AppButton>
          <AppButton
            variant="ghost"
            size="md"
            leading={SHARE_LEADING}
            onClick={() => setShareOpen(true)}
          >
            Share
          </AppButton>
          <AppButton
            variant="primary"
            size="lg"
            leading={active ? PAUSE_LEADING : PLAY_LEADING}
            onClick={pauseWorkflow}
            disabled={workflow.isBuiltin || !active}
            title={
              workflow.isBuiltin
                ? "Built-in workflows can't be paused here"
                : !active
                  ? "Activate this workflow from chat to review its exact contract"
                  : undefined
            }
          >
            {active ? "Pause" : "Activate in chat"}
          </AppButton>
        </div>
      </header>

      {workflow_recovery && revision_id ? (
        <RecoveryPanel workflowId={workflow.id} revisionId={revision_id} />
      ) : null}

      <AppSegmented<WorkflowTab>
        value={tab}
        onValueChange={setTab}
        items={TABS}
        label="Workflow detail sections"
      />

      {tab === "plan" ? (
        <PlanTab
          key={`${workflow.slug}:${workflow.rowVersion}`}
          workflow={workflow}
          onSave={updateWorkflow}
        />
      ) : null}
      {tab === "history" ? <HistoryTab workflow={workflow} /> : null}
      {tab === "approvals" ? <ApprovalsTab workflow={workflow} /> : null}

      <ShareDialog workflow={view} open={shareOpen} onClose={() => setShareOpen(false)} />
    </DetailShell>
  );
}
