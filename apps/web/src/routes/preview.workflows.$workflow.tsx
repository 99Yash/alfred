import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Copy,
  Link2,
  MoreHorizontal,
  Play,
  Share2,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  VsButton,
  VsCard,
  VsSegmented,
  VsSwitch,
  VsTextarea,
} from "~/components/ui/visitors";
import { getWorkflow, type WorkflowDefinition } from "~/lib/workflows";
import { cn } from "~/lib/utils";

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
const COPY_LEADING = <Copy size={13} />;

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

function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-4xl px-4 sm:px-6 py-10 sm:py-16">
        <div className="space-y-8">{children}</div>
      </main>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/preview/workflows"
      className={cn(
        "inline-flex items-center gap-2 text-sm text-vs-fg-3",
        "transition-colors hover:text-vs-fg-4",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background rounded",
      )}
    >
      <ArrowLeft size={14} />
      All workflows
    </Link>
  );
}

type WhenMode = "schedule" | "triggers";

const WHEN_TABS = [
  { value: "schedule" as const, label: "Schedule" },
  { value: "triggers" as const, label: "Triggers" },
];

function PlanTab({ workflow }: { workflow: WorkflowDefinition }) {
  const initialMode: WhenMode =
    workflow.trigger.type === "Schedule" ? "schedule" : "triggers";
  const [mode, setMode] = useState<WhenMode>(initialMode);

  return (
    <div className="grid gap-4">
      <VsCard>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-vs-fg-4">When</span>
          <VsSegmented<WhenMode>
            value={mode}
            onValueChange={setMode}
            items={WHEN_TABS}
            label="When this workflow runs"
          />
        </div>

        {mode === "schedule" ? (
          <ScheduleBuilder workflow={workflow} />
        ) : (
          <TriggerSummary workflow={workflow} />
        )}
      </VsCard>

      <VsCard>
        <label
          className="text-sm font-medium text-vs-fg-4"
          htmlFor="vs-workflow-prompt"
        >
          Prompt
        </label>
        <VsTextarea
          id="vs-workflow-prompt"
          value={workflow.prompt}
          readOnly
          className="mt-3 min-h-[152px]"
          aria-label={`${workflow.name} prompt`}
        />
      </VsCard>

      <VsCard>
        <div className="flex items-start gap-3">
          <WorkflowIcon tone="purple">
            <Link2 size={16} />
          </WorkflowIcon>
          <div>
            <p className="text-sm font-medium text-vs-fg-4">
              Using Integrations
            </p>
            <p className="mt-1 text-xs leading-5 text-vs-fg-3">
              {workflow.integrations.join(", ")}. You can mention integrations
              using @ in the prompt when editing custom workflows.
            </p>
          </div>
        </div>
      </VsCard>

      <div className="flex justify-end">
        <VsButton disabled title="Builtin workflow previews are read-only">
          Submit changes
        </VsButton>
      </div>
    </div>
  );
}

function ScheduleBuilder({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-vs-fg-4">
      <span className="text-vs-fg-3">From</span>
      <FauxControl>
        <CalendarClock size={13} className="text-vs-fg-3" />
        <span>Starting date</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
      <span className="text-vs-fg-3">run</span>
      <FauxControl>
        <span>every</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
      <FauxControl className="w-12 justify-center">
        <span>1</span>
      </FauxControl>
      <FauxControl>
        <span>day</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
      <span className="text-vs-fg-3">at</span>
      <FauxControl>
        <span>{scheduleTimeLabel(workflow.cadence)}</span>
        <ChevronDown size={13} className="text-vs-fg-2" />
      </FauxControl>
    </div>
  );
}

function TriggerSummary({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="mt-4 flex items-start gap-3">
      <WorkflowIcon tone="purple">
        <Zap size={16} />
      </WorkflowIcon>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-vs-fg-4">
          {workflow.trigger.type} trigger
        </p>
        <p className="mt-1 text-xs leading-5 text-vs-fg-3">
          {workflow.trigger.summary}
        </p>
      </div>
    </div>
  );
}

function FauxControl({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg bg-vs-bg-1",
        "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
        "h-8 px-2.5 text-[12.5px] font-medium text-vs-fg-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

function scheduleTimeLabel(cadence: string): string {
  const match = cadence.match(/\d{1,2}:\d{2}(\s*(?:AM|PM|am|pm))?/);
  return match ? match[0].trim() : "08:00";
}

function HistoryTab({ workflow }: { workflow: WorkflowDefinition }) {
  const rows = [
    {
      title: `${workflow.name} completed`,
      description:
        workflow.trigger.type === "Schedule"
          ? "Delivered the latest briefing."
          : "Processed the latest event batch.",
      time: "Today",
      status: "Completed",
    },
    {
      title: "No-op run",
      description: "Checked for eligible work and found nothing urgent.",
      time: "Yesterday",
      status: "No changes",
    },
  ];

  return (
    <VsCard>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-medium text-vs-fg-4">Recent runs</p>
        <span className="rounded-full bg-vs-bg-2 px-2.5 py-1 text-[11px] text-vs-fg-3">
          Preview data
        </span>
      </div>
      <div className="divide-y divide-vs-bg-3">
        {rows.map((row) => (
          <div key={row.title} className="flex items-center gap-3 py-3">
            <WorkflowIcon tone="green">
              <CheckCircle2 size={16} />
            </WorkflowIcon>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-vs-fg-4">
                {row.title}
              </p>
              <p className="truncate text-xs text-vs-fg-3">{row.description}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs text-vs-fg-3">{row.status}</p>
              <p className="text-[11px] text-vs-fg-2">{row.time}</p>
            </div>
          </div>
        ))}
      </div>
    </VsCard>
  );
}

function ApprovalsTab({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="grid gap-4">
      <VsCard>
        <div className="flex items-start gap-3">
          <WorkflowIcon tone="green">
            <ShieldCheck size={16} />
          </WorkflowIcon>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-vs-fg-4">
              No pending approvals
            </p>
            <p className="mt-1 text-xs leading-5 text-vs-fg-3">
              {workflow.name} can run automatically for low-risk steps.
              Outbound or destructive actions still stop for review.
            </p>
          </div>
        </div>
      </VsCard>

      <VsCard>
        <p className="text-sm font-medium text-vs-fg-4">Approval policy</p>
        <div className="mt-4 divide-y divide-vs-bg-3 overflow-hidden rounded-2xl bg-vs-bg-2/40 shadow-[0_0_0_1px_rgba(0,0,0,0.04)]">
          <PolicyRow label="Internal planning" value="Auto eligible" />
          <PolicyRow label="Email or calendar writes" value="Human gate" />
          <PolicyRow label="Workflow edits" value="Human gate" />
        </div>
      </VsCard>
    </div>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <p className="text-xs text-vs-fg-3">{label}</p>
      <p className="min-w-0 truncate text-right text-xs font-medium text-vs-fg-4">
        {value}
      </p>
    </div>
  );
}

function WorkflowIcon({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "green" | "purple";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl",
        tone === "green" ? "bg-vs-green-1 text-vs-green-4" : "bg-vs-purple-1 text-vs-purple-4",
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Share dialog                                                                */
/*                                                                            */
/* Inline lightweight modal — visitors-now grammar doesn't ship a VsDialog    */
/* primitive yet. Pattern mirrors the SearchPalette: fixed overlay + center-  */
/* aligned VsCard. ESC closes; backdrop click closes.                         */
/* -------------------------------------------------------------------------- */

interface ShareDialogProps {
  workflow: WorkflowDefinition;
  open: boolean;
  onClose: () => void;
}

function ShareDialog({ workflow, open, onClose }: ShareDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <dialog
      open
      aria-modal="true"
      aria-label="Share workflow"
      className="fixed inset-0 z-[60] m-0 flex max-h-none max-w-none items-start justify-center border-0 bg-transparent p-0 pt-[14vh] vs-fade-in"
    >
      <button
        type="button"
        aria-label="Close share dialog"
        onClick={onClose}
        className="absolute inset-0 bg-vs-background/55 backdrop-blur-[2px]"
      />
      <div
        className={cn(
          "relative w-[min(520px,92vw)] rounded-2xl bg-vs-bg-1",
          "shadow-[0_24px_64px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
        )}
      >
        <div className="px-6 pt-5 pb-2">
          <p className="text-sm font-medium text-vs-fg-4">Share workflow</p>
          <p className="mt-1 text-xs text-vs-fg-3">
            Copy a private link to this workflow preview.
          </p>
        </div>
        <div className="px-6 pb-6">
          <div className="rounded-2xl bg-vs-bg-2/60 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] p-4">
            <div className="flex items-center gap-3">
              <WorkflowIcon tone="purple">
                <Share2 size={16} />
              </WorkflowIcon>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-vs-fg-4">
                  {workflow.name}
                </p>
                <p className="truncate text-[12px] text-vs-fg-3">
                  {workflow.description}
                </p>
              </div>
            </div>
            <div
              className={cn(
                "mt-4 flex items-center gap-2 rounded-xl bg-vs-bg-1 px-3 py-2",
                "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
              )}
            >
              <Link2 size={14} className="shrink-0 text-vs-fg-2" />
              <p className="min-w-0 flex-1 truncate text-[12.5px] text-vs-fg-3">
                alfred.local/workflows/{workflow.id}
              </p>
              <VsButton variant="ghost" size="sm" leading={COPY_LEADING}>
                Copy
              </VsButton>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <VsButton variant="white" size="md" onClick={onClose}>
              Close
            </VsButton>
          </div>
        </div>
      </div>
    </dialog>
  );
}
