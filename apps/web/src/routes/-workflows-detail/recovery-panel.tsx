import { activateWorkflowInputSchema } from "@alfred/contracts";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";

import { AppCard } from "~/components/ui/v2";
import { client } from "~/lib/eden";

interface RecoveryPanelProps {
  workflowId: string;
  revisionId: string;
}

export function RecoveryPanel({ workflowId, revisionId }: RecoveryPanelProps) {
  const recovery = useQuery({
    queryKey: ["workflow-recovery", workflowId, revisionId],
    queryFn: async () => {
      const response = await client.api
        .workflows({ id: workflowId })
        .recovery.post({}, { query: { revisionId } });
      if (response.error || !response.data) throw new Error("Workflow recovery failed");
      return response.data;
    },
    retry: false,
  });

  if (recovery.isPending) {
    return (
      <AppCard className="flex items-center gap-3 px-4 py-3 text-sm text-app-fg-3">
        <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        Rechecking this workflow after connection…
      </AppCard>
    );
  }

  if (recovery.isError || !recovery.data.ok) {
    return (
      <AppCard className="flex items-start gap-3 px-4 py-3 text-sm text-rose-700">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium">This draft could not be recovered.</p>
          <p className="mt-0.5 text-xs leading-5 text-rose-600">
            The draft may have changed while the connection was open. Review its current version.
          </p>
        </div>
      </AppCard>
    );
  }

  if (recovery.data.status === "blocked") {
    return (
      <AppCard className="flex items-start gap-3 px-4 py-3 text-sm text-amber-800">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">Connection restored, but setup is not complete.</p>
          <ul className="mt-1 space-y-1 text-xs leading-5 text-amber-700">
            {recovery.data.readiness.map((problem) => (
              <li key={`${problem.code}:${problem.field}`}>{problem.message}</li>
            ))}
          </ul>
        </div>
      </AppCard>
    );
  }

  const proposal = activateWorkflowInputSchema.safeParse(recovery.data.activationProposal);
  if (!proposal.success) {
    return (
      <AppCard className="flex items-start gap-3 px-4 py-3 text-sm text-rose-700">
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        The recovered activation proposal is invalid. Review the draft before activation.
      </AppCard>
    );
  }

  return (
    <AppCard className="p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_18px_rgba(0,0,0,0.04)]">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-app-fg-4">Ready to activate</p>
          <p className="mt-0.5 text-xs leading-5 text-pretty text-app-fg-3">
            The connection is ready. Review the exact workflow contract before you approve it in
            chat.
          </p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-app-fg-2">Schedule</dt>
              <dd className="mt-0.5 text-app-fg-4">{proposal.data.schedule.summary}</dd>
            </div>
            <div>
              <dt className="text-app-fg-2">Capabilities</dt>
              <dd className="mt-0.5 text-app-fg-4">
                {proposal.data.resolvedCapabilities
                  .map((capability) =>
                    capability.accountLabel
                      ? `${capability.title} · ${capability.accountLabel}`
                      : capability.title,
                  )
                  .join(", ")}
              </dd>
            </div>
          </dl>
          {proposal.data.authoringProposal.externalEffects.length > 0 ? (
            <p className="mt-3 text-xs leading-5 text-pretty text-app-fg-3">
              External effects: {proposal.data.authoringProposal.externalEffects.join(", ")}.
            </p>
          ) : null}
        </div>
      </div>
    </AppCard>
  );
}
