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
 * Readers for the `system.ask_user` approval (ADR-0099). Its staged input and
 * tool previews are untyped JSON, so they are parsed here against the contract.
 */

export const EMPTY_ANSWER: AskUserAnswer = Object.freeze({
  selectedOptions: [],
  customAnswer: null,
});

/** Whitespace-only free text counts as empty. The schema does not trim, so we decide here. */
export function isAnswerEmpty(answer: AskUserAnswer): boolean {
  return answer.selectedOptions.length === 0 && !answer.customAnswer?.trim();
}

/** Null when the value is not an ask_user input, so the caller falls back to the JSON editor. */
export function parseAskUserInput(value: unknown): AskUserInput | null {
  const parsed = askUserInput.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/** A staged row that is a question, with its input already parsed. */
export interface QuestionStaging {
  staging: SyncedActionStaging;
  input: AskUserInput;
  /** The unparsed input that answers are written back onto. */
  raw: JsonRecord;
}

/**
 * Read a staged row as a question, or `null`.
 * A row whose tool name matches but whose input fails to parse (a newer schema)
 * must fall back to the write card.
 */
export function asQuestionStaging(staging: SyncedActionStaging): QuestionStaging | null {
  if (!isQuestionApproval(staging.toolName)) return null;
  const raw = asRecord(staging.proposedInput);

  if (!raw) return null;
  const input = parseAskUserInput(raw);

  return input ? { staging, input, raw } : null;
}

/** Padded to one answer per question. */
export function answersOf(input: AskUserInput): AskUserAnswer[] {
  return input.questions.map((_, index) => input.answers?.[index] ?? EMPTY_ANSWER);
}

/** Blank questions. A pager hides unopened pages, so the card must say how many. */
export function unansweredCount(input: AskUserInput): number {
  return answersOf(input).filter(isAnswerEmpty).length;
}

/**
 * Write answers onto the raw input, not the parsed one: parsed schema defaults
 * would make the draft look edited.
 * All-empty answers drop the key, so the tool reports `no_answers`.
 */
export function withAnswers(rawInput: JsonRecord, answers: readonly AskUserAnswer[]): JsonRecord {
  const next = { ...rawInput };

  if (answers.every(isAnswerEmpty)) delete next.answers;
  else next.answers = answers;

  return next;
}

export interface AnsweredQuestion {
  question: AskUserQuestion;
  answer: AskUserAnswer;
}

export type AskUserSummary =
  | { status: "answered"; answered: AnsweredQuestion[] }
  | Omit<AskUserUnansweredResult, "message">;

/**
 * Read the settled summary off a finished tool call.
 * `preview()` cuts `questions` and `answers` to the same length, so a truncated
 * preview still parses but drops questions. Only the producer's `resultTruncated`
 * shows this; then we return null and the caller draws the plain tool row.
 * A 3-question call with long descriptions already overflows, so this is common.
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
