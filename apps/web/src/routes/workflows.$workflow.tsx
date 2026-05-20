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
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { getWorkflow, type WorkflowDefinition } from "~/lib/workflows";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/workflows/$workflow")({
  component: WorkflowDetailPage,
});

type WorkflowTab = "plan" | "history" | "approvals";

const TABS: ReadonlyArray<TabItem<WorkflowTab>> = [
  { value: "plan", label: "Plan" },
  { value: "history", label: "History" },
  { value: "approvals", label: "Approvals" },
];

function WorkflowDetailPage() {
  const { workflow: workflowId } = Route.useParams();
  const workflow = getWorkflow(workflowId);
  const [tab, setTab] = useState<WorkflowTab>("plan");
  const [shareOpen, setShareOpen] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);

  if (!workflow) {
    return (
      <DetailShell>
        <BackLink />
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-950">Workflow not found</p>
          <p className="max-w-md text-[12.5px] text-gray-800">
            This workflow is not available in the local preview.
          </p>
        </Card>
      </DetailShell>
    );
  }

  return (
    <DetailShell>
      <BackLink />

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="heading-display text-[32px] leading-[38px] font-medium tracking-tight">
            {workflow.name}
          </h1>
          <p className="mt-1 max-w-xl text-sm leading-5 text-gray-800">{workflow.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="md" aria-label="More workflow actions">
            <MoreHorizontal size={16} />
          </Button>
          <Button
            variant="ghost"
            size="md"
            leading={<Share2 size={14} />}
            onClick={() => setShareOpen(true)}
          >
            Share
          </Button>
          <label
            htmlFor="workflow-auto-approve"
            className={cn(
              "inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03]",
              "h-8 px-3 text-sm text-gray-900 cursor-pointer select-none",
              "transition-colors hover:bg-white/[0.05]",
            )}
          >
            <span>Auto approve</span>
            <Switch
              id="workflow-auto-approve"
              checked={autoApprove}
              onCheckedChange={setAutoApprove}
            />
          </label>
          <Button size="mdPlus" leading={<Play size={14} />}>
            Activate
          </Button>
        </div>
      </header>

      <Tabs<WorkflowTab>
        variant="underline"
        value={tab}
        onValueChange={setTab}
        items={TABS}
        label="Workflow detail sections"
      />

      {tab === "plan" ? <PlanTab workflow={workflow} /> : null}
      {tab === "history" ? <HistoryTab workflow={workflow} /> : null}
      {tab === "approvals" ? <ApprovalsTab workflow={workflow} /> : null}

      <WorkflowShareDialog
        workflow={workflow}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </DetailShell>
  );
}

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="md:hidden h-6" />
      <div className="space-y-8">{children}</div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/workflows"
      className="inline-flex items-center gap-2 text-sm text-gray-800 transition-colors hover:text-gray-1000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
    >
      <ArrowLeft size={14} />
      All workflows
    </Link>
  );
}

type WhenMode = "schedule" | "triggers";

const WHEN_TABS: ReadonlyArray<TabItem<WhenMode>> = [
  { value: "schedule", label: "Schedule" },
  { value: "triggers", label: "Triggers" },
];

function PlanTab({ workflow }: { workflow: WorkflowDefinition }) {
  const initialMode: WhenMode = workflow.trigger.type === "Schedule" ? "schedule" : "triggers";
  const [mode, setMode] = useState<WhenMode>(initialMode);

  return (
    <div className="grid gap-4">
      <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-gray-1000">When</span>
          <Tabs<WhenMode>
            variant="segmented"
            value={mode}
            onValueChange={setMode}
            items={WHEN_TABS}
            label="When this workflow runs"
            className="h-9"
          />
        </div>

        {mode === "schedule" ? (
          <ScheduleBuilder workflow={workflow} />
        ) : (
          <TriggerSummary workflow={workflow} />
        )}
      </Card>

      <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <label className="text-sm font-medium text-gray-1000" htmlFor="workflow-prompt">
          Prompt
        </label>
        <Textarea
          id="workflow-prompt"
          value={workflow.prompt}
          readOnly
          className="mt-3 min-h-[152px]"
          aria-label={`${workflow.name} prompt`}
        />
      </Card>

      <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="frost-icon-tile grid size-9 shrink-0 place-items-center rounded-xl text-gray-900"
          >
            <Link2 size={16} />
          </span>
          <div>
            <p className="text-sm font-medium text-gray-1000">Using Integrations</p>
            <p className="mt-1 text-[12.5px] leading-5 text-gray-800">
              {workflow.integrations.join(", ")}. You can mention integrations using @ in the prompt
              when editing custom workflows.
            </p>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button disabled title="Builtin workflow previews are read-only">
          Submit changes
        </Button>
      </div>
    </div>
  );
}

function ScheduleBuilder({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-gray-900">
      <span className="text-gray-800">From</span>
      <FauxControl>
        <CalendarClock size={13} className="text-gray-800" />
        <span>Starting date</span>
        <ChevronDown size={13} className="text-gray-700" />
      </FauxControl>
      <span className="text-gray-800">run</span>
      <FauxControl>
        <span>every</span>
        <ChevronDown size={13} className="text-gray-700" />
      </FauxControl>
      <FauxControl className="w-12 justify-center">
        <span>1</span>
      </FauxControl>
      <FauxControl>
        <span>day</span>
        <ChevronDown size={13} className="text-gray-700" />
      </FauxControl>
      <span className="text-gray-800">at</span>
      <FauxControl>
        <span>{scheduleTimeLabel(workflow.cadence)}</span>
        <ChevronDown size={13} className="text-gray-700" />
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
        <p className="text-sm font-medium text-gray-1000">{workflow.trigger.type} trigger</p>
        <p className="mt-1 text-[12.5px] leading-5 text-gray-800">{workflow.trigger.summary}</p>
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
        "inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03]",
        "h-8 px-2.5 text-[12.5px] font-medium text-gray-950",
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
    <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-medium text-gray-1000">Recent runs</p>
        <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] text-gray-800">
          Preview data
        </span>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {rows.map((row) => (
          <div key={row.title} className="flex items-center gap-3 py-3">
            <WorkflowIcon tone="green">
              <CheckCircle2 size={16} />
            </WorkflowIcon>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-950">{row.title}</p>
              <p className="truncate text-[12.5px] text-gray-800">{row.description}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[12px] text-gray-850">{row.status}</p>
              <p className="text-[11px] text-gray-700">{row.time}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ApprovalsTab({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="grid gap-4">
      <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex items-start gap-3">
          <WorkflowIcon tone="green">
            <ShieldCheck size={16} />
          </WorkflowIcon>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-1000">No pending approvals</p>
            <p className="mt-1 text-[12.5px] leading-5 text-gray-800">
              {workflow.name} can run automatically for low-risk steps. Outbound or destructive
              actions still stop for review.
            </p>
          </div>
        </div>
      </Card>

      <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <p className="text-sm font-medium text-gray-1000">Approval policy</p>
        <div className="mt-4 divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/[0.06] bg-[#111]/70">
          <TriggerRow label="Internal planning" value="Auto eligible" />
          <TriggerRow label="Email or calendar writes" value="Human gate" />
          <TriggerRow label="Workflow edits" value="Human gate" />
        </div>
      </Card>
    </div>
  );
}

function WorkflowShareDialog({
  workflow,
  open,
  onOpenChange,
}: {
  workflow: WorkflowDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Share workflow"
        description="Copy a private link to this workflow preview."
        className="max-w-[520px]"
      >
        <div className="px-6 pb-6">
          <div className="rounded-2xl border border-white/[0.06] bg-[#111]/80 p-4">
            <div className="flex items-center gap-3">
              <WorkflowIcon tone="purple">
                <Share2 size={16} />
              </WorkflowIcon>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-950">{workflow.name}</p>
                <p className="truncate text-[12px] text-gray-700">{workflow.description}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2">
              <Link2 size={14} className="shrink-0 text-gray-700" />
              <p className="min-w-0 flex-1 truncate text-[12.5px] text-gray-800">
                alfred.local/workflows/{workflow.id}
              </p>
              <Button variant="ghost" size="sm" leading={<Copy size={13} />}>
                Copy
              </Button>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => onOpenChange(false)} variant="white" size="md">
              Close share dialog
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TriggerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <p className="text-[12.5px] text-gray-800">{label}</p>
      <p className="min-w-0 truncate text-right text-[12.5px] font-medium text-gray-950">{value}</p>
    </div>
  );
}

function WorkflowIcon({ children, tone }: { children: ReactNode; tone: "green" | "purple" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl",
        tone === "green"
          ? "bg-emerald-500/12 text-emerald-300"
          : "bg-purple-500/12 text-purple-300",
      )}
    >
      {children}
    </span>
  );
}
