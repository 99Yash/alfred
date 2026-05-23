import { ShieldCheck } from "lucide-react";
import { VsCard } from "~/components/ui/visitors";
import type { WorkflowDefinition } from "~/lib/workflows";
import { PolicyRow } from "./policy-row";
import { WorkflowIcon } from "./workflow-icon";

export function ApprovalsTab({ workflow }: { workflow: WorkflowDefinition }) {
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
