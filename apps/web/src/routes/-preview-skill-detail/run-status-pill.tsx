import { CheckCircle2, XCircle } from "lucide-react";
import { AppPill } from "~/components/ui/v2";
import type { PreviewSkillRun } from "~/lib/preview-skills";

export function RunStatusPill({ status }: { status: PreviewSkillRun["status"] }) {
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
  return (
    <AppPill tone="amber">
      <span aria-hidden className="size-1.5 rounded-full bg-app-amber-4 animate-pulse mr-1" />
      Running
    </AppPill>
  );
}
