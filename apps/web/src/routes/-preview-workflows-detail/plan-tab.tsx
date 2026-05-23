import { Link2 } from "lucide-react";
import { useState } from "react";
import { VsButton, VsCard, VsSegmented, VsTextarea } from "~/components/ui/visitors";
import type { WorkflowDefinition } from "~/lib/workflows";
import { ScheduleBuilder } from "./schedule-builder";
import { TriggerSummary } from "./trigger-summary";
import { WorkflowIcon } from "./workflow-icon";

type WhenMode = "schedule" | "triggers";

const WHEN_TABS = [
  { value: "schedule" as const, label: "Schedule" },
  { value: "triggers" as const, label: "Triggers" },
];

export function PlanTab({ workflow }: { workflow: WorkflowDefinition }) {
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
