import { useParams } from "@tanstack/react-router";
import { MoreHorizontal, Pause, Play, Share2 } from "lucide-react";
import { useState } from "react";
import { VsButton, VsCard, VsSegmented, VsSwitch } from "~/components/ui/visitors";
import { useWorkflow } from "~/lib/replicache/use-workflows";
import { cn } from "~/lib/utils";
import { syncedWorkflowToView } from "~/lib/workflows";
import { ApprovalsTab } from "./approvals-tab";
import { BackLink } from "./back-link";
import { DetailShell } from "./detail-shell";
import { HistoryTab } from "./history-tab";
import { PlanTab } from "./plan-tab";
import { ShareDialog } from "./share-dialog";

type WorkflowTab = "plan" | "history" | "approvals";

const TABS = [
  { value: "plan" as const, label: "Plan" },
  { value: "history" as const, label: "History" },
  { value: "approvals" as const, label: "Approvals" },
];

const SHARE_LEADING = <Share2 size={14} />;

export function PreviewWorkflowDetailPage() {
  const { workflow: slug } = useParams({ from: "/workflows/$workflow" });
  const { workflow, updateWorkflow, loading } = useWorkflow(slug);
  const [tab, setTab] = useState<WorkflowTab>("plan");
  const [shareOpen, setShareOpen] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);

  if (!workflow) {
    return (
      <DetailShell>
        <BackLink />
        <VsCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-vs-fg-4">
            {loading ? "Loading workflow…" : "Workflow not found"}
          </p>
          {!loading ? (
            <p className="max-w-md text-xs text-vs-fg-3 leading-5">
              No workflow with this slug is synced to this device.
            </p>
          ) : null}
        </VsCard>
      </DetailShell>
    );
  }

  const view = syncedWorkflowToView(workflow);
  const active = workflow.status === "active";

  const toggleActive = () => void updateWorkflow({ status: active ? "paused" : "active" });

  return (
    <DetailShell>
      <BackLink />

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[32px] leading-[38px] font-medium tracking-tight text-vs-fg-4">
            {workflow.name}
          </h1>
          {workflow.description ? (
            <p className="mt-1 max-w-xl text-sm leading-5 text-vs-fg-3">{workflow.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <VsButton variant="ghost" size="md" aria-label="More workflow actions">
            <MoreHorizontal size={16} />
          </VsButton>
          <VsButton
            variant="ghost"
            size="md"
            leading={SHARE_LEADING}
            onClick={() => setShareOpen(true)}
          >
            Share
          </VsButton>
          <label
            htmlFor="vs-workflow-auto-approve"
            className={cn(
              "inline-flex items-center gap-2 rounded-full bg-vs-bg-1",
              "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
              "h-8 px-3 text-sm text-vs-fg-4 cursor-pointer select-none",
              "transition-colors hover:bg-vs-bg-a1",
            )}
          >
            <span>Auto approve</span>
            <VsSwitch
              id="vs-workflow-auto-approve"
              checked={autoApprove}
              onCheckedChange={setAutoApprove}
            />
          </label>
          <VsButton
            variant="primary"
            size="lg"
            leading={active ? <Pause size={14} /> : <Play size={14} />}
            onClick={toggleActive}
            disabled={workflow.isBuiltin}
            title={workflow.isBuiltin ? "Built-in workflows can't be paused here" : undefined}
          >
            {active ? "Pause" : "Activate"}
          </VsButton>
        </div>
      </header>

      <VsSegmented<WorkflowTab>
        value={tab}
        onValueChange={setTab}
        items={TABS}
        label="Workflow detail sections"
      />

      {tab === "plan" ? <PlanTab workflow={workflow} onSave={updateWorkflow} /> : null}
      {tab === "history" ? <HistoryTab workflow={view} /> : null}
      {tab === "approvals" ? <ApprovalsTab workflow={view} /> : null}

      <ShareDialog workflow={view} open={shareOpen} onClose={() => setShareOpen(false)} />
    </DetailShell>
  );
}
