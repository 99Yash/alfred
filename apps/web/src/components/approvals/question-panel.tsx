import type { AskUserAnswer, AskUserInput, AskUserQuestion } from "@alfred/contracts";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { AppTextarea } from "~/components/ui/v2";
import type { JsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
import { answersOf, withAnswers } from "./ask-user";

/**
 * The answer sheet for a parked `system.ask_user` approval (ADR-0099).
 *
 * This is the `system.ask_user` shape of {@link ApprovalInputEditor}: the
 * user's answers ARE the tool input, so filling the card edits the staged
 * input in place and the ordinary "approve with edits" path carries the
 * answers back to the model. One question renders flat; two or more page one
 * at a time, so a four-question call never becomes a wall of radios.
 */
export function AskUserQuestionPanel({
  input,
  rawValue,
  onChange,
  disabled,
  idPrefix,
}: {
  /** The staged input, parsed. Drives what the card draws. */
  input: AskUserInput;
  /**
   * The same input as it was staged, unparsed. Answers are written back onto
   * this value, not onto `input`: parsing applies schema defaults, and a draft
   * carrying those would read as edited before the user answers anything.
   */
  rawValue: JsonRecord;
  onChange: (value: unknown) => void;
  disabled?: boolean | undefined;
  idPrefix: string;
}) {
  const questions = input.questions;
  const answers = answersOf(input);
  const [index, setIndex] = useState(0);
  // The staged question list is frozen once the row is written, but clamp
  // anyway so a shorter list can never index past its end.
  const current = Math.min(index, questions.length - 1);
  const question = questions[current]!;
  const answer = answers[current]!;

  const setAnswer = (next: AskUserAnswer) => {
    const updated = answers.map((existing, i) => (i === current ? next : existing));
    onChange(withAnswers(rawValue, updated));
  };

  return (
    <div className="flex flex-col gap-3">
      {input.context ? (
        <MarkdownRenderer size="compact" tone="surface" className="text-app-fg-3">
          {input.context}
        </MarkdownRenderer>
      ) : null}

      <div className="rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)]">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="inline-flex max-w-full items-center truncate rounded-md bg-app-bg-1 px-1.5 py-0.5 text-[11px] font-medium text-app-fg-3">
              {question.header}
            </span>
            <p className="mt-1.5 text-[14px] leading-6 font-medium text-pretty text-app-fg-4">
              {question.question}
            </p>
          </span>
          {questions.length > 1 ? (
            <QuestionPager
              current={current}
              total={questions.length}
              onGo={(next) => setIndex(next)}
            />
          ) : null}
        </div>

        <OptionList
          question={question}
          answer={answer}
          onAnswer={setAnswer}
          disabled={disabled}
          name={`${idPrefix}-q${current}`}
        />

        <label
          htmlFor={`${idPrefix}-custom-${current}`}
          className="mt-3 block text-[12px] font-medium text-app-fg-3"
        >
          Or write your own answer
        </label>
        <AppTextarea
          id={`${idPrefix}-custom-${current}`}
          value={answer.customAnswer ?? ""}
          onChange={(e) =>
            setAnswer({ ...answer, customAnswer: e.target.value === "" ? null : e.target.value })
          }
          rows={2}
          disabled={disabled}
          placeholder="Type an answer here."
          className="mt-1.5 min-h-14"
        />
      </div>
    </div>
  );
}

/** Previous / next arrows and the position counter for a multi-question call. */
function QuestionPager({
  current,
  total,
  onGo,
}: {
  current: number;
  total: number;
  onGo: (next: number) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <PagerButton
        label="Previous question"
        disabled={current === 0}
        onClick={() => onGo(current - 1)}
      >
        <ChevronLeft size={14} />
      </PagerButton>
      <span className="text-[12px] text-app-fg-3 tabular-nums">
        {current + 1} of {total}
      </span>
      <PagerButton
        label="Next question"
        disabled={current === total - 1}
        onClick={() => onGo(current + 1)}
      >
        <ChevronRight size={14} />
      </PagerButton>
    </span>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-lg text-app-fg-3",
        "app-press transition-colors outline-none hover:bg-app-bg-a2 hover:text-app-fg-4",
        "focus-visible:ring-2 focus-visible:ring-app-purple-2",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The choices for one question. A single-select question is a native radio
 * group, so the arrow keys move the selection; a multi-select one is native
 * checkboxes. The inputs stay in the accessibility tree and carry focus; the
 * visible state is drawn from React so the card needs no checked-selector
 * gymnastics.
 */
function OptionList({
  question,
  answer,
  onAnswer,
  disabled,
  name,
}: {
  question: AskUserQuestion;
  answer: AskUserAnswer;
  onAnswer: (next: AskUserAnswer) => void;
  disabled: boolean | undefined;
  name: string;
}) {
  const multi = question.multiSelect;
  const toggle = (label: string, checked: boolean) => {
    if (!multi) {
      onAnswer({ ...answer, selectedOptions: [label] });
      return;
    }
    onAnswer({
      ...answer,
      selectedOptions: checked
        ? [...answer.selectedOptions, label]
        : answer.selectedOptions.filter((selected) => selected !== label),
    });
  };

  return (
    <div className="mt-2.5 flex flex-col gap-1" role={multi ? "group" : "radiogroup"}>
      {question.options.map((option) => {
        const checked = answer.selectedOptions.includes(option.label);
        return (
          <label
            key={option.label}
            className={cn(
              "relative flex items-start gap-2.5 rounded-xl px-2.5 py-2",
              "transition-colors",
              checked ? "bg-app-purple-1" : "hover:bg-app-bg-a2",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
          >
            <input
              type={multi ? "checkbox" : "radio"}
              name={name}
              value={option.label}
              checked={checked}
              disabled={disabled}
              onChange={(e) => toggle(option.label, e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 rounded-xl peer-focus-visible:ring-2 peer-focus-visible:ring-app-purple-2"
            />
            <span
              aria-hidden
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center transition-colors",
                multi ? "rounded-[5px]" : "rounded-full",
                checked
                  ? "bg-[var(--app-accent-from)] text-[var(--app-accent-fg)]"
                  : "bg-app-bg-1 shadow-[0_0_0_1px_var(--app-fg-a1)]",
              )}
            >
              {checked ? (
                multi ? (
                  <Check size={10} strokeWidth={3.5} />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )
              ) : null}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] leading-5 font-medium text-app-fg-4">
                {option.label}
              </span>
              {option.description ? (
                <span className="mt-0.5 block text-[12px] leading-5 text-app-fg-3">
                  {option.description}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
