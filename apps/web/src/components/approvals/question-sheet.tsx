import { Check, Loader2, X } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { asRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { parseAskUserInput, unansweredCount, type QuestionStaging } from "./ask-user";
import { AskUserQuestionPanel } from "./question-panel";

// Hoisted so `leading` gets a stable element.
const ICON_X = <X size={13} />;

const ICON_CHECK = <Check size={13} />;

/** Body and actions of a parked `system.ask_user` approval (ADR-0099), shared by chat and `/approvals`. */
export function QuestionSheet({
  question,
  draftInput,
  onDraftChange,
  busy,
  decided,
  error,
  idPrefix,
  onContinue,
  onDismiss,
  settledLabel,
  className,
}: {
  question: QuestionStaging;
  draftInput: unknown;
  onDraftChange: (value: unknown) => void;
  busy: boolean;
  decided: boolean;
  error: string | null;
  idPrefix: string;
  onContinue: () => void;
  onDismiss: () => void;
  settledLabel: string;
  className?: string | undefined;
}) {
  // Read the draft. Every control writes a schema-valid value, so a refused
  // draft cannot come from this card; fall back to the staged pair.
  const draftRaw = asRecord(draftInput);
  const draftInputParsed = draftRaw ? parseAskUserInput(draftRaw) : null;
  const input = draftInputParsed ?? question.input;
  const raw = draftInputParsed ? draftRaw! : question.raw;
  const blanks = unansweredCount(input);
  const locked = busy || decided;

  return (
    <div
      className={cn("border-t border-app-bg-a2 p-3 sm:px-4", className)}
      onKeyDown={(event) => {
        // Cmd/Ctrl+Enter continues, scoped to this sheet.
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;

        if (locked) return;
        event.preventDefault();
        onContinue();
      }}
    >
      <AskUserQuestionPanel
        input={input}
        rawValue={raw}
        onChange={onDraftChange}
        disabled={locked}
        idPrefix={idPrefix}
      />

      {/* `alert` so a 409 from a stale row is spoken, not only painted. */}
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-app-red-4">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] leading-5 text-app-fg-2">
          <kbd className="rounded bg-app-bg-1 px-1 font-sans">⌘</kbd>
          <kbd className="ml-0.5 rounded bg-app-bg-1 px-1 font-sans">Enter</kbd> to continue
        </p>
        {decided ? (
          <div className="flex min-h-8 items-center gap-2 text-[13px] font-medium text-app-fg-3">
            <Loader2 size={14} className="animate-spin" />
            {settledLabel}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AppButton
              variant="ghost"
              size="sm"
              leading={ICON_X}
              disabled={busy}
              onClick={onDismiss}
            >
              Dismiss
            </AppButton>
            <AppButton
              variant="primary"
              size="sm"
              leading={ICON_CHECK}
              loading={busy}
              disabled={busy}
              onClick={onContinue}
            >
              {/* The pager hides other pages, so the label warns of blanks. */}
              {blanks > 0 ? "Continue anyway" : "Continue"}
            </AppButton>
          </div>
        )}
      </div>
    </div>
  );
}
