import { CheckCircle2, XCircle } from "lucide-react";
import { VsPill } from "~/components/ui/visitors";
import type { PreviewSkillRun } from "~/lib/preview-skills";

export function RunStatusPill({ status }: { status: PreviewSkillRun["status"] }) {
  if (status === "completed") {
    return (
      <VsPill tone="green">
        <CheckCircle2 size={11} aria-hidden className="mr-1" /> Completed
      </VsPill>
    );
  }
  if (status === "failed") {
    return (
      <VsPill tone="red">
        <XCircle size={11} aria-hidden className="mr-1" /> Failed
      </VsPill>
    );
  }
  return (
    <VsPill tone="amber">
      <span aria-hidden className="size-1.5 rounded-full bg-vs-amber-4 animate-pulse mr-1" />
      Running
    </VsPill>
  );
}
