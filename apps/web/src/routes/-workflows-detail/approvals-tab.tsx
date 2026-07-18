import { ShieldCheck } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import type { WorkflowDefinition } from "~/routes/-workflows/workflows-utils";
import { PolicyRow } from "./policy-row";
import { WorkflowIcon } from "./workflow-icon";

export function ApprovalsTab({ workflow }: { workflow: WorkflowDefinition }) {
  return (
    <div className="grid gap-4">
      <AppCard>
        <div className="flex items-start gap-3">
          <WorkflowIcon tone="green">
            <ShieldCheck size={16} />
          </WorkflowIcon>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-app-fg-4">No pending approvals</p>
            <p className="mt-1 text-xs leading-5 text-app-fg-3">
              {workflow.name} can run automatically for low-risk steps. Outbound or destructive
              actions still stop for review.
            </p>
          </div>
        </div>
      </AppCard>

      <AppCard>
        <p className="text-sm font-medium text-app-fg-4">Approval policy</p>
        <div className="mt-4 divide-y divide-app-bg-3 overflow-hidden rounded-2xl bg-app-bg-2/40 shadow-[0_0_0_1px_rgba(0,0,0,0.04)]">
          <PolicyRow label="Internal planning" value="Auto eligible" />
          <PolicyRow label="Email or calendar writes" value="Human gate" />
          <PolicyRow label="Workflow edits" value="Human gate" />
        </div>
      </AppCard>
    </div>
  );
}
