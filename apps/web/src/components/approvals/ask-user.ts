import {
  askUserInput,
  askUserResultSchema,
  isQuestionApproval,
  parseJsonWith,
  type AskUserAnswer,
  type AskUserInput,
  type AskUserQuestion,
  type AskUserUnansweredResult,
} from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";
import type { JsonRecord } from "~/lib/json-record";
import { asRecord } from "~/lib/json-record";

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

/** A staged row that is a question, with its input already parsed. */
export interface QuestionStaging {
  staging: SyncedActionStaging;
  input: AskUserInput;
  /** The same input unparsed — what an answer is written back onto. */
  raw: JsonRecord;
}

/**
 * Read one staged row as a question, or `null` when it is not one.
 *
 * Fuses the tool-name check with the parse, because the two are one question
 * ("can this row draw an answer sheet?") and every caller asked both halves.
 * The parse can fail on a row whose tool name matches — a build whose schema
 * has moved on — and that row must fall back to the write card rather than to
 * nothing.
 */
export function asQuestionStaging(staging: SyncedActionStaging): QuestionStaging | null {
  if (!isQuestionApproval(staging.toolName)) return null;
  const raw = asRecord(staging.proposedInput);

  if (!raw) return null;
  const input = parseAskUserInput(raw);

  return input ? { staging, input, raw } : null;
}

/** The answers held on a draft input, padded to one entry per question. */
export function answersOf(input: AskUserInput): AskUserAnswer[] {
  return input.questions.map((_, index) => input.answers?.[index] ?? EMPTY_ANSWER);
}

/**
 * How many questions the user has left blank. Drives the card's warning line
 * and its button copy: a pager shows one question at a time, so nothing else
 * on screen says that page 3 of 4 was never opened.
 */
export function unansweredCount(input: AskUserInput): number {
  return answersOf(input).filter(isAnswerEmpty).length;
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
 * Read the settled summary off a finished tool call.
 *
 * The card draws from a *preview*, and `preview()` prunes a preview that
 * overflows its character budget: strings shorten, arrays slice, object keys
 * past a limit drop. Pruning cuts `questions` and `answers` to the SAME
 * length, so a truncated preview still parses and still pairs correctly — it
 * just omits whole questions. No reader can detect that by looking, which is
 * why `resultTruncated` is stated by the producer and carried on the tool call
 * (live event, durable row, and sync entity alike). A truncated preview
 * returns null here and the caller draws the ordinary tool row rather than a
 * card that hides answers under the heading "Your answers".
 *
 * Measured at 3 options per question, a 3-question call with 120-character
 * descriptions already overflows, so this is the common case for the pager,
 * not a corner.
 */
export function askUserSummary(tool: {
  resultPreview?: string | undefined;
  resultTruncated?: boolean | undefined;
}): AskUserSummary | null {
  if (!tool.resultPreview || tool.resultTruncated) return null;
  const result = parseJsonWith(tool.resultPreview, askUserResultSchema);

  if (!result) return null;

  if (result.status === "unanswered") {
    return { status: "unanswered", reason: result.reason, questions: result.questions };
  }

  if (result.questions.length !== result.answers.length) return null;

  return {
    status: "answered",
    answered: result.questions.map((question, index) => ({
      question,
      answer: result.answers[index]!,
    })),
  };
}
