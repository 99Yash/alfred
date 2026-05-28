import { ClipboardCheck, Loader2 } from "lucide-react";
import { VsCard, VsPill } from "~/components/ui/visitors";
import { client } from "~/lib/eden";
import { useActionStagings } from "~/lib/replicache/use-action-stagings";
import { ApprovalCard, type ApprovalDecision } from "./approval-card";

/**
 * Live `/approvals` queue. Reads pending action stagings straight from
 * Replicache (`useActionStagings`) and posts decisions back through the Eden
 * decision API. A successful decision flips the row out of `pending`
 * server-side; the resulting poke pulls the card off the list — so there is
 * no optimistic local removal here.
 */
export function ApprovalsPage() {
  const { rows, loading } = useActionStagings();

  const decide = async (stagingId: string, decision: ApprovalDecision) => {
    const { error } = await client.api.approvals({ stagingId }).decision.post(decision);
    if (error) throw new Error(decisionErrorMessage(error.value));
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
        <header className="mb-9 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[36px] leading-[42px] font-medium tracking-[-0.04em] text-vs-fg-4">
              Approvals
            </h1>
            <p className="mt-2 text-sm text-vs-fg-3">Gated workflow actions waiting for review.</p>
          </div>
          <VsPill tone={rows.length > 0 ? "amber" : undefined}>{rows.length} pending</VsPill>
        </header>

        {loading ? (
          <VsCard className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-vs-fg-3">
            <Loader2 size={16} className="animate-spin" />
            Loading approvals…
          </VsCard>
        ) : rows.length === 0 ? (
          <VsCard className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span
              className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
              aria-hidden
            >
              <ClipboardCheck size={18} />
            </span>
            <p className="text-sm font-medium text-vs-fg-4">No pending approvals</p>
            <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
              Alfred will pause here when a workflow reaches a gated action.
            </p>
          </VsCard>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((staging) => (
              <ApprovalCard
                key={staging.id}
                staging={staging}
                onDecide={(decision) => decide(staging.id, decision)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function decisionErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Failed to record decision";
}
