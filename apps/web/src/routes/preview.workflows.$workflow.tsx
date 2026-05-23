import { createFileRoute } from "@tanstack/react-router";
import { MoreHorizontal, Play, Share2 } from "lucide-react";
import { useState } from "react";
import {
  VsButton,
  VsCard,
  VsSegmented,
  VsSwitch,
} from "~/components/ui/visitors";
import { getWorkflow } from "~/lib/workflows";
import { cn } from "~/lib/utils";
import { ApprovalsTab } from "./-preview-workflows-detail/approvals-tab";
import { BackLink } from "./-preview-workflows-detail/back-link";
import { DetailShell } from "./-preview-workflows-detail/detail-shell";
import { HistoryTab } from "./-preview-workflows-detail/history-tab";
import { PlanTab } from "./-preview-workflows-detail/plan-tab";
import { ShareDialog } from "./-preview-workflows-detail/share-dialog";

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
export const Route = createFileRoute("/preview/workflows/$workflow")({
  component: PreviewWorkflowDetailPage,
});

type WorkflowTab = "plan" | "history" | "approvals";

const TABS = [
  { value: "plan" as const, label: "Plan" },
  { value: "history" as const, label: "History" },
  { value: "approvals" as const, label: "Approvals" },
];

const SHARE_LEADING = <Share2 size={14} />;
const ACTIVATE_LEADING = <Play size={14} />;

function PreviewWorkflowDetailPage() {
  const { workflow: workflowId } = Route.useParams();
  const workflow = getWorkflow(workflowId);
  const [tab, setTab] = useState<WorkflowTab>("plan");
  const [shareOpen, setShareOpen] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);

  if (!workflow) {
    return (
      <DetailShell>
        <BackLink />
        <VsCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-vs-fg-4">Workflow not found</p>
          <p className="max-w-md text-xs text-vs-fg-3 leading-5">
            This workflow is not available in the local preview.
          </p>
        </VsCard>
      </DetailShell>
    );
  }

  return (
    <DetailShell>
      <BackLink />

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[32px] leading-[38px] font-medium tracking-tight text-vs-fg-4">
            {workflow.name}
          </h1>
          <p className="mt-1 max-w-xl text-sm leading-5 text-vs-fg-3">
            {workflow.description}
          </p>
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
          <VsButton variant="primary" size="lg" leading={ACTIVATE_LEADING}>
            Activate
          </VsButton>
        </div>
      </header>

      <VsSegmented<WorkflowTab>
        value={tab}
        onValueChange={setTab}
        items={TABS}
        label="Workflow detail sections"
      />

      {tab === "plan" ? <PlanTab workflow={workflow} /> : null}
      {tab === "history" ? <HistoryTab workflow={workflow} /> : null}
      {tab === "approvals" ? <ApprovalsTab workflow={workflow} /> : null}

      <ShareDialog
        workflow={workflow}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </DetailShell>
  );
}
