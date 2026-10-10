import type { AskUserAnswer, AskUserInput, AskUserQuestion, JsonObject } from "@alfred/contracts";
import { ASK_USER_LIMITS } from "@alfred/contracts";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { AppTextarea } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { answersOf, isAnswerEmpty, withAnswers } from "./ask-user";

/**
 * Answer sheet for a parked `system.ask_user` approval (ADR-0099). The answers are
 * the tool input, so "approve with edits" carries them back. Two or more questions page.
 */
export function AskUserQuestionPanel({
  input,
  rawValue,
  onChange,
  disabled,
  idPrefix,
}: {
  input: AskUserInput;
  /** Answers are written here, not onto `input`: parsed defaults would look like edits. */
  rawValue: JsonObject;
  onChange: (value: unknown) => void;
  disabled?: boolean | undefined;
  idPrefix: string;
}) {
  const questions = input.questions;
  const answers = answersOf(input);
  const [index, setIndex] = useState(0);
  // Clamp so a shorter list can never index past its end.
  const current = Math.min(index, questions.length - 1);
  const question = questions[current]!;
  const answer = answers[current]!;
  const questionId = `${idPrefix}-question-${current}`;
  const blanks = answers.filter(isAnswerEmpty).length;

  const setAnswer = (next: AskUserAnswer) => {
    const updated = answers.map((existing, i) => (i === current ? next : existing));
    onChange(withAnswers(rawValue, updated));
  };

  return (
    <div className="flex flex-col gap-3">
      {input.context ? (
        // Model-authored context often quotes an email body, so no remote images.
        <MarkdownRenderer size="compact" tone="surface" images="alt-text" className="text-app-fg-3">
          {input.context}
        </MarkdownRenderer>
      ) : null}

      <div className="rounded-xl bg-app-bg-2/60 p-3 shadow-[0_0_0_1px_var(--app-bg-a2)]">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <span className="inline-flex max-w-full items-center truncate rounded-md bg-app-bg-1 px-1.5 py-0.5 text-[11px] font-medium text-app-fg-3">
              {question.header}
            </span>
            <p
              id={questionId}
              className="mt-1.5 text-[14px] leading-6 font-medium text-pretty text-app-fg-4"
            >
              {question.question}
            </p>
          </div>
          {questions.length > 1 ? (
            <QuestionPager
              current={current}
              answers={answers}
              disabled={disabled}
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
          labelledBy={questionId}
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
          // Same cap as the schema; a longer paste would fail the parse mid-edit.
          maxLength={ASK_USER_LIMITS.customAnswer.max}
          disabled={disabled}
          placeholder="Type an answer here."
          className="mt-1.5 min-h-14"
        />
      </div>

      {blanks > 0 ? <BlankNotice blanks={blanks} total={questions.length} /> : null}
    </div>
  );
}

/** Count of blank questions. Pages hide each other; this informs without blocking. */
function BlankNotice({ blanks, total }: { blanks: number; total: number }) {
  return (
    <p role="status" className="text-[12px] leading-5 text-app-amber-4">
      {blanks === total
        ? `Nothing answered yet. Continue sends no answers and Alfred carries on with an assumption.`
        : `${blanks} of ${total} questions ${blanks === 1 ? "is" : "are"} still blank. Continue sends only what you filled in.`}
    </p>
  );
}

/** Arrows, one dot per question (answered state, jump target), and a position readout. */
function QuestionPager({
  current,
  answers,
  disabled,
  onGo,
}: {
  current: number;
  answers: readonly AskUserAnswer[];
  disabled: boolean | undefined;
  onGo: (next: number) => void;
}) {
  const total = answers.length;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <PagerButton
        label="Previous question"
        inert={disabled || current === 0}
        onClick={() => onGo(current - 1)}
      >
        <ChevronLeft size={14} />
      </PagerButton>
      <span className="flex items-center gap-1">
        {answers.map((answer, i) => (
          <PagerDot
            key={i}
            index={i}
            total={total}
            answered={!isAnswerEmpty(answer)}
            active={i === current}
            disabled={disabled}
            onClick={() => onGo(i)}
          />
        ))}
      </span>
      <PagerButton
        label="Next question"
        inert={disabled || current === total - 1}
        onClick={() => onGo(current + 1)}
      >
        <ChevronRight size={14} />
      </PagerButton>
      {/* A page change has no text change a screen reader notices, so announce it. */}
      <span aria-live="polite" className="sr-only">
        Question {current + 1} of {total}
      </span>
    </div>
  );
}

function PagerDot({
  index,
  total,
  answered,
  active,
  disabled,
  onClick,
}: {
  index: number;
  total: number;
  answered: boolean;
  active: boolean;
  disabled: boolean | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Question ${index + 1} of ${total}${answered ? ", answered" : ", blank"}`}
      aria-current={active ? "true" : undefined}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
      className={cn(
        "app-focus size-2 rounded-full transition-colors",
        answered ? "bg-[var(--app-accent-from)]" : "bg-app-fg-a1",
        active && "ring-1 ring-app-fg-2 ring-offset-1 ring-offset-app-bg-2",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
      )}
    />
  );
}

/**
 * `aria-disabled` with a no-op, not `disabled`: disabling a focused button
 * blurs it, and the next Tab restarts at the top of the document.
 */
function PagerButton({
  label,
  inert,
  onClick,
  children,
}: {
  label: string;
  inert: boolean | undefined;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={inert || undefined}
      onClick={() => {
        if (inert) return;
        onClick();
      }}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-lg text-app-fg-3",
        "app-focus app-press transition-colors",
        inert
          ? "cursor-not-allowed opacity-40"
          : "cursor-pointer hover:bg-app-bg-a2 hover:text-app-fg-4",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Native radios (single) or checkboxes (multi), so the keyboard works.
 * `labelledBy` names the group with the question text.
 */
function OptionList({
  question,
  answer,
  onAnswer,
  disabled,
  name,
  labelledBy,
}: {
  question: AskUserQuestion;
  answer: AskUserAnswer;
  onAnswer: (next: AskUserAnswer) => void;
  disabled: boolean | undefined;
  name: string;
  labelledBy: string;
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

  // Labels are unique per schema, so they are sound keys. Build the set once per render.
  const selected = new Set(answer.selectedOptions);

  return (
    <div
      className="mt-2.5 flex flex-col gap-1"
      role={multi ? "group" : "radiogroup"}
      aria-labelledby={labelledBy}
    >
      {question.options.map((option) => {
        const checked = selected.has(option.label);

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
              className="pointer-events-none absolute inset-0 rounded-xl peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:-outline-offset-1 peer-focus-visible:outline-[var(--app-accent-ring)]"
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
