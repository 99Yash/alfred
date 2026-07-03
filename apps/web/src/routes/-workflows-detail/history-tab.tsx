import { CheckCircle2 } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import type { WorkflowDefinition } from "~/lib/workflows";
import { WorkflowIcon } from "./workflow-icon";

export function HistoryTab({ workflow }: { workflow: WorkflowDefinition }) {
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
    <AppCard>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-medium text-app-fg-4">Recent runs</p>
        <span className="rounded-full bg-app-bg-2 px-2.5 py-1 text-[11px] text-app-fg-3">
          Preview data
        </span>
      </div>
      <div className="divide-y divide-app-bg-3">
        {rows.map((row) => (
          <div key={row.title} className="flex items-center gap-3 py-3">
            <WorkflowIcon tone="green">
              <CheckCircle2 size={16} />
            </WorkflowIcon>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-app-fg-4">{row.title}</p>
              <p className="truncate text-xs text-app-fg-3">{row.description}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs text-app-fg-3">{row.status}</p>
              <p className="text-[11px] text-app-fg-2">{row.time}</p>
            </div>
          </div>
        ))}
      </div>
    </AppCard>
  );
}
