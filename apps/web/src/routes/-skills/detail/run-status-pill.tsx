import type { SyncedSkillRun } from "@alfred/sync";
import { CheckCircle2, XCircle } from "lucide-react";
import { AppPill } from "~/components/ui/v2";

export function RunStatusPill({ status }: { status: SyncedSkillRun["status"] }) {
  if (status === "completed") {
    return (
      <AppPill tone="green">
        <CheckCircle2 size={11} aria-hidden className="mr-1" /> Completed
      </AppPill>
    );
  }
  if (status === "failed") {
    return (
      <AppPill tone="red">
        <XCircle size={11} aria-hidden className="mr-1" /> Failed
      </AppPill>
    );
  }
  if (status === "cancelled") return <AppPill>Cancelled</AppPill>;
  return (
    <AppPill tone="amber">
      <span aria-hidden className="mr-1 size-1.5 animate-pulse rounded-full bg-app-amber-4" />
      {status === "waiting" ? "Waiting" : status === "pending" ? "Pending" : "Running"}
    </AppPill>
  );
}
