import { Check, Pencil, X } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { ConfidenceChip } from "./confidence-chip";
import type { LocalFact } from "./helpers";

const CONFIRM_LEADING = <Check size={12} />;
const EDIT_LEADING = <Pencil size={12} />;
const REJECT_LEADING = <X size={12} />;

export function ProposedFactCard({
  fact,
  onConfirm,
  onReject,
}: {
  fact: LocalFact;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <AppCard className="space-y-2.5 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <code className="font-mono text-[12px] text-app-fg-4 break-all">{fact.key}</code>
        <ConfidenceChip confidence={fact.confidence} />
      </div>
      <div className="rounded-md bg-app-bg-2 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-app-fg-4">
        {fact.value}
      </div>
      <div className="text-[11px] text-app-fg-3 tabular-nums">
        {fact.source} · {new Date(fact.createdAt).toLocaleString()}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <AppButton variant="primary" size="sm" onClick={onConfirm} leading={CONFIRM_LEADING}>
          Confirm
        </AppButton>
        <AppButton variant="ghost" size="sm" leading={EDIT_LEADING}>
          Edit
        </AppButton>
        <AppButton variant="ghost" size="sm" onClick={onReject} leading={REJECT_LEADING}>
          Reject
        </AppButton>
      </div>
    </AppCard>
  );
}
