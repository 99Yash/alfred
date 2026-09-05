import { integrationDisplayName, isIntegrationSlug } from "@alfred/contracts";
import type { SyncedWorkflow } from "@alfred/sync";
import { ShieldCheck } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { ApprovalCard } from "~/components/approvals/approval-card";
import { decideApproval } from "~/components/approvals/decide-approval";
import { useActionPolicy } from "~/lib/replicache/use-action-policy";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { PolicyRow } from "./policy-row";
import { WorkflowIcon } from "./workflow-icon";

/**
 * The approvals this workflow is waiting on (#561), read from the same synced
 * staging queue the `/approvals` page uses and filtered to this workflow. The
 * policy card states, per allowed integration, whether its writes run without
 * approval or wait here; it reads the real action policy, not a local switch.
 */
export function ApprovalsTab({ workflow }: { workflow: SyncedWorkflow }) {
  const { rows, loading, error, retry } = useActionStagings();
  const { modeFor } = useActionPolicy();
  const pending = rows.filter((row) => row.workflowSlug === workflow.slug);
  const integrations = workflow.allowedIntegrations.filter(isIntegrationSlug);

  return (
    <div className="grid gap-4">
      {error ? (
        <AppCard className="flex items-center justify-between gap-3">
          <p className="text-xs text-rose-600">{error}</p>
          <AppButton variant="white" size="sm" onClick={retry}>
            Retry
          </AppButton>
        </AppCard>
      ) : null}

      {pending.length > 0 ? (
        <div className="grid gap-3">
          {pending.map((staging) => (
            <ApprovalCard
              key={staging.id}
              staging={staging}
              onDecide={(decision) => decideApproval(staging.id, decision)}
            />
          ))}
        </div>
      ) : (
        <AppCard>
          <div className="flex items-start gap-3">
            <WorkflowIcon tone="green">
              <ShieldCheck size={16} />
            </WorkflowIcon>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-app-fg-4">
                {loading ? "Loading approvals…" : "No pending approvals"}
              </p>
              <p className="mt-1 text-xs leading-5 text-pretty text-app-fg-3">
                Every external write this workflow attempts waits here, unless you gave its
                integration full autonomy. Reads never need approval.
              </p>
            </div>
          </div>
        </AppCard>
      )}

      <AppCard>
        <p className="text-sm font-medium text-app-fg-4">Approval policy</p>
        {integrations.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-app-fg-3">No integrations allowed.</p>
        ) : (
          <div className="mt-4 divide-y divide-app-bg-3 overflow-hidden rounded-2xl bg-app-bg-2/40 shadow-[0_0_0_1px_rgba(0,0,0,0.04)]">
            {integrations.map((slug) => (
              <PolicyRow
                key={slug}
                label={integrationDisplayName(slug)}
                // Fall back to the conservative `gated` while the policy row loads.
                value={
                  (modeFor(slug) ?? "gated") === "autonomy"
                    ? "Runs without approval"
                    : "Needs your approval"
                }
              />
            ))}
          </div>
        )}
      </AppCard>
    </div>
  );
}
