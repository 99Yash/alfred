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
  tool_approval: "your approval",
  document: "a mail",
  observation: "an activity event",
  web_page: "a web page",
} as const satisfies Record<SyncedFact["evidence"][number]["kind"], string>;

/** Who made the claim (ADR-0123). */
function authorLine(fact: SyncedFact): string {
  return fact.author === "user" ? "You said it" : "Alfred concluded it";
}

/** A page URL that is safe as a link: `http` or `https` only. */
function isWebLink(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol } = new URL(url);

  return protocol === "https:" || protocol === "http:";
}

/** The pages that the claim cites, so the user can read them before a confirm. */
function webPages(fact: SyncedFact): string[] {
  return [
    ...new Set(
      fact.evidence.flatMap((link) =>
        link.kind === "web_page" && isWebLink(link.url) ? [link.url] : [],
      ),
    ),
  ];
}

/** The other kinds of evidence, as words. */
function otherEvidence(fact: SyncedFact): string[] {
  return [
    ...new Set(
      fact.evidence.flatMap((link) =>
        link.kind === "web_page" ? [] : [EVIDENCE_KIND_LABEL[link.kind]],
      ),
    ),
  ];
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
      <div className="space-y-1 text-[11px] text-app-fg-3">
        <div className="tabular-nums">
          {authorLine(fact)}
          {otherEvidence(fact).length > 0 ? ` from ${otherEvidence(fact).join(", ")}` : ""} ·{" "}
          {new Date(fact.createdAt).toLocaleString()}
        </div>
        {webPages(fact).length > 0 ? (
          <ul className="space-y-0.5">
            {webPages(fact).map((url) => (
              <li key={url} className="truncate">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-app-bg-3 underline-offset-2 hover:text-app-fg-4"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
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
