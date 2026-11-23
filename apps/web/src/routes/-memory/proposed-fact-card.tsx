import { toDisplayText } from "@alfred/contracts";
import type { SyncedFact } from "@alfred/sync";
import { Check, X } from "lucide-react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { ConfidenceChip } from "./confidence-chip";

const CONFIRM_LEADING = <Check size={12} />;

const REJECT_LEADING = <X size={12} />;

const EVIDENCE_KIND_LABEL = {
  chat_message: "your chat message",
  user_edit: "your edit",
  document: "a document",
  observation: "an observation",
  web_page: "a web page",
} as const satisfies Record<SyncedFact["evidence"][number]["kind"], string>;

/** Who made the claim, and the kinds of evidence it cites (ADR-0123). */
function formatProvenance(fact: SyncedFact): string {
  const author = fact.author === "user" ? "You said it" : "Alfred concluded it";
  const kinds = [...new Set(fact.evidence.map((link) => EVIDENCE_KIND_LABEL[link.kind]))];

  return kinds.length > 0 ? `${author} from ${kinds.join(", ")}` : author;
}

export function ProposedFactCard({
  fact,
  onConfirm,
  onReject,
}: {
  fact: SyncedFact;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <AppCard className="space-y-2.5 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <code className="font-mono text-[12px] break-all text-app-fg-4">{fact.key}</code>
        <ConfidenceChip confidence={fact.confidence} />
      </div>
      <div className="rounded-control-sm bg-app-bg-2 px-3 py-2 font-mono text-[12px] wrap-break-word whitespace-pre-wrap text-app-fg-4">
        {toDisplayText(fact.value, 2)}
      </div>
      <div className="text-[11px] text-app-fg-3 tabular-nums">
        {formatProvenance(fact)} · {new Date(fact.createdAt).toLocaleString()}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        <AppButton variant="primary" size="sm" onClick={onConfirm} leading={CONFIRM_LEADING}>
          Confirm
        </AppButton>
        <AppButton variant="ghost" size="sm" onClick={onReject} leading={REJECT_LEADING}>
          Reject
        </AppButton>
      </div>
    </AppCard>
  );
}
