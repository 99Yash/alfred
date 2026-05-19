import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Clock3, Link2, MoreHorizontal, Play, Share2 } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { getWorkflow, type WorkflowDefinition } from "~/lib/workflows";

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
          <Button variant="ghost" size="md" leading={<Share2 size={14} />}>
            Share
          </Button>
          <Button variant="ghost" size="md" aria-label="More workflow actions">
            <MoreHorizontal size={16} />
          </Button>
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
      {tab === "history" ? (
        <EmptyTab
          icon={<Play size={18} />}
          title="No workflow runs yet"
          description="Once a workflow is run, you can see the history here."
        />
      ) : null}
      {tab === "approvals" ? (
        <EmptyTab
          icon={<CheckCircle2 size={18} />}
          title="Nothing to approve"
          description="If approval is needed, it will show up here."
        />
      ) : null}
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

function PlanTab({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="grid gap-4">
      <Card className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-gray-1000">When</p>
            <p className="mt-1 text-[12.5px] leading-5 text-gray-800">{workflow.trigger.summary}</p>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/[0.05] px-3 py-1 text-[12px] text-gray-850">
            <Clock3 size={12} />
            {workflow.trigger.type}
          </span>
        </div>
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
            <p className="text-sm font-medium text-gray-1000">Using integrations</p>
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

function EmptyTab({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card className="grid min-h-[320px] place-items-center rounded-2xl border border-white/[0.06] bg-white/[0.02] px-6 py-12 text-center">
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className="frost-icon-tile grid size-11 place-items-center rounded-2xl text-gray-900"
        >
          {icon}
        </span>
        <p className="mt-4 text-sm font-medium text-gray-950">{title}</p>
        <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-gray-800">{description}</p>
      </div>
    </Card>
  );
}
