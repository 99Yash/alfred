import {
  askUserInput,
  askUserResultSchema,
  parseJsonWith,
  type AskUserAnswer,
  type AskUserInput,
  type AskUserQuestion,
  type AskUserUnansweredResult,
} from "@alfred/contracts";
import type { JsonRecord } from "~/lib/json-record";

/**
 * Readers for the `system.ask_user` approval (ADR-0099). The staged row's
 * `proposedInput` and a settled turn's tool previews are both untyped JSON, so
 * every shape the question card draws is parsed here against the contracts
 * schema instead of being asserted at the call site.
 */

/** An untouched answer: no option picked, no free text. */
export const EMPTY_ANSWER: AskUserAnswer = Object.freeze({
  selectedOptions: [],
  customAnswer: null,
});

/**
 * The user has not said anything for this question yet. Whitespace-only free
 * text counts as nothing: `askUserAnswerSchema` no longer trims `customAnswer`
 * (a trim there ate every space the user typed), so emptiness is decided here,
 * at the one boundary that asks the question.
 */
export function isAnswerEmpty(answer: AskUserAnswer): boolean {
  return answer.selectedOptions.length === 0 && !answer.customAnswer?.trim();
}

/**
 * Parse a staged question's proposed input. Returns null when the value is not
 * a `system.ask_user` input, so the caller can fall back to the generic
 * JSON editor rather than draw a card over a shape it cannot read.
 */
export function parseAskUserInput(value: unknown): AskUserInput | null {
  const parsed = askUserInput.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The answers held on a draft input, padded to one entry per question. */
export function answersOf(input: AskUserInput): AskUserAnswer[] {
  return input.questions.map((_, index) => input.answers?.[index] ?? EMPTY_ANSWER);
}

/**
 * Write answers back onto the raw draft input. Takes the *raw* record rather
 * than the parsed input so the draft keeps the exact bytes the dispatcher
 * staged: parsing applies schema defaults (`multiSelect`), and a draft
 * carrying those extra keys would read as "edited" before the user touches
 * anything.
 *
 * An all-empty answer set drops the key entirely. That keeps "the user pressed
 * Continue without answering" as an unedited approval, which the tool reports
 * to the model as `no_answers` instead of as an answer sheet full of blanks.
 */
export function withAnswers(rawInput: JsonRecord, answers: readonly AskUserAnswer[]): JsonRecord {
  const next = { ...rawInput };
  if (answers.every(isAnswerEmpty)) delete next.answers;
  else next.answers = answers;
  return next;
}

/** One question and what the user said to it, in question order. */
export interface AnsweredQuestion {
  question: AskUserQuestion;
  answer: AskUserAnswer;
}

/** What a settled `system.ask_user` call resolved to, for the read-only card. */
export type AskUserSummary =
  | { status: "answered"; answered: AnsweredQuestion[] }
  | Omit<AskUserUnansweredResult, "message">;

/**
 * Read the settled summary off a finished tool call's result preview.
 *
 * The preview is capped at 2000 characters and pruned array-by-array when it
 * overflows, so a long question set can arrive with trailing pairs dropped.
 * Pruning cuts `questions` and `answers` to the *same* length, which is why an
 * equal pair count proves nothing: a truncated preview still parses and still
 * pairs correctly, it just omits whole questions. The answered arm therefore
 * carries `questionCount`, a scalar the pruner leaves alone. Fewer pairs than
 * that count means the preview is lossy, this returns null, and the caller
 * draws the ordinary tool row rather than a card that hides answers under the
 * heading "Your answers".
 *
 * Two lesser losses survive the guard on purpose: one long question or answer
 * string can arrive truncated with `…`, and a `selectedOptions` list of 6 can
 * arrive holding 5. Neither attributes an answer to the wrong question.
 */
export function askUserSummary(resultPreview: string | undefined): AskUserSummary | null {
  if (!resultPreview) return null;
  const result = parseJsonWith(resultPreview, askUserResultSchema);
  if (!result) return null;
  if (result.status === "unanswered") {
    return { status: "unanswered", reason: result.reason, questions: result.questions };
  }
  if (result.questions.length !== result.answers.length) return null;
  if (result.questions.length !== result.questionCount) return null;
  return {
    status: "answered",
    answered: result.questions.map((question, index) => ({
      question,
      answer: result.answers[index]!,
    })),
  };
}
