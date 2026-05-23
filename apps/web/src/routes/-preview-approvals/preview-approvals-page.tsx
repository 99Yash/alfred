import { ClipboardCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { ApprovalCard } from "~/components/preview/approvals/approval-card";
import { ApprovalsShell } from "~/components/preview/approvals/approvals-shell";
import type { LocalApproval } from "~/components/preview/approvals/types";
import { VsCard } from "~/components/ui/visitors";

const SEED_APPROVALS: LocalApproval[] = [
  {
    id: "stg_01",
    toolName: "gmail.send_draft",
    workflowSlug: "morning-briefing",
    runId: "run_8f3c2a17be4d",
    integration: "Gmail",
    riskTier: "high",
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    recentRejection: {
      decidedAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
      reason: "Tone was too casual — tighten before resending.",
    },
    proposedInput: {
      to: ["maya@sycamore.vc"],
      cc: [],
      subject: "Re: vesting cliff",
      threadId: "thr_9120af",
      bodyText:
        "Hi Maya — the 4-year cliff is on Aug 14. Happy to pull the cap-table snapshot tonight if useful. — Y",
    },
  },
  {
    id: "stg_02",
    toolName: "calendar.create_event",
    workflowSlug: "morning-briefing",
    runId: "run_8f3c2a17be4d",
    integration: "Google Calendar",
    riskTier: "medium",
    createdAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    proposedInput: {
      summary: "Focus block — Sycamore recap",
      start: "2026-05-24T14:00:00+05:30",
      end: "2026-05-24T15:30:00+05:30",
      attendees: [],
      description: "Pulled from morning briefing — keep phone on silent.",
    },
  },
];

export function PreviewApprovalsPage() {
  const [approvals, setApprovals] = useState<LocalApproval[]>(SEED_APPROVALS);

  const sorted = useMemo(
    () => approvals.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [approvals],
  );

  const removeApproval = (id: string) => setApprovals((prev) => prev.filter((a) => a.id !== id));

  return (
    <ApprovalsShell count={sorted.length}>
      {sorted.length === 0 ? (
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
          {sorted.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onResolve={() => removeApproval(approval.id)}
            />
          ))}
        </div>
      )}
    </ApprovalsShell>
  );
}
