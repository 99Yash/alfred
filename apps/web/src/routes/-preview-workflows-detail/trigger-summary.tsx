import { Zap } from "lucide-react";
import type { WorkflowDefinition } from "~/lib/workflows";
import { WorkflowIcon } from "./workflow-icon";

export function TriggerSummary({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="mt-4 flex items-start gap-3">
      <WorkflowIcon tone="purple">
        <Zap size={16} />
      </WorkflowIcon>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-vs-fg-4">{workflow.trigger.type} trigger</p>
        <p className="mt-1 text-xs leading-5 text-vs-fg-3">{workflow.trigger.summary}</p>
      </div>
    </div>
  );
}
