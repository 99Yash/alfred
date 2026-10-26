import { isTerminalStatus } from "@alfred/contracts/agent";
import type { SyncedSkillRun } from "@alfred/sync";
import { CheckCircle2, XCircle } from "lucide-react";
import { AppPill } from "~/components/ui/v2";
import { RUN_STATUS_DISPLAY } from "~/lib/run-status";

export function RunStatusPill({ status }: { status: SyncedSkillRun["status"] }) {
  const { label, tone } = RUN_STATUS_DISPLAY[status];

  return (
    <AppPill tone={tone === "muted" ? undefined : tone}>
      {tone === "green" ? (
        <CheckCircle2 size={11} aria-hidden className="mr-1" />
      ) : tone === "red" ? (
        <XCircle size={11} aria-hidden className="mr-1" />
      ) : isTerminalStatus(status) ? null : (
        <span aria-hidden className="mr-1 size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {label}
    </AppPill>
  );
}
