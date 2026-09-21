import { Check, Loader2, X } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { asRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { parseAskUserInput, unansweredCount, type QuestionStaging } from "./ask-user";
import { AskUserQuestionPanel } from "./question-panel";

// Hoisted so the `leading` props below don't allocate a fresh element per render.
const ICON_X = <X size={13} />;

const ICON_CHECK = <Check size={13} />;

/**
 * The body and the action row of a parked `system.ask_user` approval
 * (ADR-0099), shared by the chat tray's card and the `/approvals` queue's.
 *
 * Both surfaces draw the same answer sheet, so both get the same keyboard
 * contract, the same blank-aware button copy, and the same error announcement
 * from one place. Only the chrome above it differs: chat leads with Alfred's
 * avatar inside the transcript, `/approvals` with the queue's row metadata.
 */
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
  /** Copy for the in-flight row once a decision has landed. */
  settledLabel: string;
  /** Padding override, so each surface's card keeps its own rhythm. */
  className?: string | undefined;
}) {
  // Read the *draft*, so the blank count and the answers the panel draws are
  // what the user has actually filled in. A draft the schema refuses is
  // unreachable from this card — every control writes a schema-valid value and
  // the free-text field is capped at the schema's own limit — so the staged
  // pair is the fallback rather than a raw-JSON editor.
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
        // Cmd/Ctrl+Enter continues from anywhere in the sheet, including the
        // custom-answer field. Scoped to the sheet, so it can never fire for a
        // question the user is not looking at.
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
              {/* The pager shows one question at a time, so the label carries
               * the fact that pressing this sends an incomplete sheet. */}
              {blanks > 0 ? "Continue anyway" : "Continue"}
            </AppButton>
          </div>
        )}
      </div>
    </div>
  );
}
