import {
  askUserInput,
  askUserResultSchema,
  isQuestionApproval,
  type AskUserAnswer,
  type AskUserInput,
  type AskUserQuestion,
  type AskUserUnansweredResult,
  type JsonObject,
  jsonObjectSchema,
} from "@alfred/contracts";
import type { SyncedActionStaging } from "@alfred/sync";

import type { ResolvedToolCall } from "~/lib/chat/resolved-tool-call";

/**
 * Readers for the `system.ask_user` approval (ADR-0099). Its staged input and
 * tool previews are untyped JSON, so they are parsed here against the contract.
 */

const EMPTY_ANSWER: AskUserAnswer = Object.freeze({
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
  raw: JsonObject;
}

/** A staged row, classified one time. A question whose input fails to parse is a `write`. */
export type StagedRow =
  | ({ kind: "question" } & QuestionStaging)
  | { kind: "write"; staging: SyncedActionStaging };

/**
 * Classify a staged row as a question or a write.
 * A row whose tool name matches but whose input fails to parse (a newer schema)
 * must fall back to the write card.
 */
export function toStagedRow(staging: SyncedActionStaging): StagedRow {
  if (!isQuestionApproval(staging.toolName)) return { kind: "write", staging };
  const parsed = jsonObjectSchema.safeParse(staging.proposedInput);

  if (!parsed.success) return { kind: "write", staging };
  const raw = parsed.data;
  const input = parseAskUserInput(raw);

  return input ? { kind: "question", staging, input, raw } : { kind: "write", staging };
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
export function withAnswers(rawInput: JsonObject, answers: readonly AskUserAnswer[]): JsonObject {
  const next = { ...rawInput };

  if (answers.every(isAnswerEmpty)) delete next.answers;
  else next.answers = answers;

  return next;
}

interface AnsweredQuestion {
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
export function askUserSummary(
  tool: Pick<ResolvedToolCall, "result" | "resultTruncated">,
): AskUserSummary | null {
  if (!tool.result || tool.resultTruncated) return null;
  const parsed = askUserResultSchema.safeParse(tool.result);

  if (!parsed.success) return null;
  const result = parsed.data;

  if (result.status === "unanswered") {
    return { status: "unanswered", reason: result.reason, questions: result.questions };
  }

  if (result.questions.length !== result.answers.length) return null;
  const answered: AnsweredQuestion[] = [];

  for (const [index, question] of result.questions.entries()) {
    const answer = result.answers[index];

    if (answer === undefined) return null;
    answered.push({ question, answer });
  }

  return { status: "answered", answered };
}
