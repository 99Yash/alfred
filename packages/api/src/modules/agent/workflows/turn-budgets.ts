import type { AgentTranscriptMessage } from "@alfred/contracts";
import type { StepResult } from "../types";
import type { ChatRunState } from "./chat-turn-state";

/**
 * Every bound on how much work one agent turn-loop may do, in one place.
 *
 * Two of these used to be a constant named `TURN_CAP_MAX` declared in both
 * agent workflows with two different values (24 and 30); the retry planners were
 * three copies of the same six lines, each carrying its own paragraph of the
 * one rule that actually matters. Co-locating them makes the numbers
 * comparable, and {@link planTurnRetry} makes the rule a parameter name
 * (`preTurnTranscript`) instead of a comment every copy has to repeat.
 */

/**
 * Turn-loop cap for the interactive chat workflow. Lower than
 * {@link BRIEF_TURN_CAP_MAX} on purpose: a user is watching this one stream, so
 * a wedged loop has to fail while they are still willing to wait, and the two
 * finalize guards can each spend a turn regenerating on top of the model's own
 * tool loop.
 */
export const CHAT_TURN_CAP_MAX = 24;

/**
 * Turn-loop cap for the background brief / sub-agent workflow. Higher than
 * {@link CHAT_TURN_CAP_MAX} because nobody is watching it stream: an
 * investigation is expected to work several distinct angles, and the run has a
 * compaction step it can spend turns on that the chat path does not.
 */
export const BRIEF_TURN_CAP_MAX = 30;

/**
 * How many consecutive empty completions (see `isRetryableEmptyCompletion`) to
 * regenerate before surfacing a failure. An empty `stop` with no text and no
 * tool calls is the transient anomaly the Anthropic→Gemini quota fallback throws
 * (a Gemini fallback candidate with 0 output tokens); re-attempting the turn
 * usually clears it. Kept tight so a provider genuinely stuck returning empties
 * fails fast instead of burning the whole turn-cap budget on full-price retries.
 * Shared by both workflows — the anomaly is the provider's, not the caller's.
 */
export const EMPTY_COMPLETION_MAX_RETRIES = 2;

/**
 * Bounded auto-retries after the streaming circuit-breaker aborts a chat turn
 * (see `isStreamTimeoutAbort`). One, not the empty-completion budget of two: a
 * timeout retry costs up to a full stream ceiling (~180s) plus full token spend,
 * so a second would leave the user staring at "Thinking…" for the better part of
 * ten minutes. One retry is strictly better than the blank failure it replaces;
 * bounding per-turn work *by construction* for large deliverables is the
 * structural fix (Gap 2 — incremental artifact authoring), not more retries.
 * Chat-only: the brief workflow does not stream, so it has no circuit-breaker.
 */
export const STREAM_TIMEOUT_MAX_RETRIES = 1;

/**
 * One retryable turn-level anomaly: which counter on the run state tracks it,
 * how many times it may fire, and which step re-issues the model call.
 */
interface TurnRetryBudget<S> {
  readonly max: number;
  readonly read: (state: S) => number;
  /** Return a copy with the counter bumped; never mutate the checkpoint state. */
  readonly bump: (state: S) => S;
  readonly nextStep: string;
}

/**
 * Plan one bounded retry of a model call, or `null` once the budget is spent.
 *
 * `preTurnTranscript` is the whole protocol: the retry MUST re-issue from the
 * transcript as it stood *before* the failed model call, never from one with
 * that call's response appended. An empty or aborted completion appends an empty
 * assistant message, and Anthropic 400s on empty assistant content — so a retry
 * built on the post-turn transcript is poisoned and fails the run for a reason
 * that has nothing to do with the anomaly it was retrying. The array is
 * forwarded by reference (not copied) so a caller can assert identity.
 *
 * Pure, so both the budget and the poison-transcript regression are directly
 * testable.
 */
function planTurnRetry<S>(
  budget: TurnRetryBudget<S>,
  state: S,
  preTurnTranscript: AgentTranscriptMessage[],
): Extract<StepResult<S>, { kind: "next" }> | null {
  if (budget.read(state) >= budget.max) return null;
  return {
    kind: "next",
    state: budget.bump(state),
    transcript: preTurnTranscript,
    nextStep: budget.nextStep,
  };
}

const CHAT_EMPTY_COMPLETION_BUDGET: TurnRetryBudget<ChatRunState> = {
  max: EMPTY_COMPLETION_MAX_RETRIES,
  read: (state) => state.emptyCompletionRetries,
  bump: (state) => ({ ...state, emptyCompletionRetries: state.emptyCompletionRetries + 1 }),
  nextStep: "chat-turn",
};

const CHAT_STREAM_TIMEOUT_BUDGET: TurnRetryBudget<ChatRunState> = {
  max: STREAM_TIMEOUT_MAX_RETRIES,
  read: (state) => state.streamTimeoutRetries,
  bump: (state) => ({ ...state, streamTimeoutRetries: state.streamTimeoutRetries + 1 }),
  nextStep: "chat-turn",
};

/** Regenerate a chat turn that came back empty, from the pre-turn transcript. */
export function planEmptyChatCompletionRetry(
  state: ChatRunState,
  preTurnTranscript: AgentTranscriptMessage[],
): StepResult<ChatRunState> | null {
  return planTurnRetry(CHAT_EMPTY_COMPLETION_BUDGET, state, preTurnTranscript);
}

/**
 * Regenerate a chat turn the streaming circuit-breaker aborted, from the
 * pre-turn transcript — which already holds every tool result gathered this run,
 * so the retry re-issues just the model call that ran long, exactly like the
 * manual resend that recovers today.
 */
export function planStreamTimeoutRetry(
  state: ChatRunState,
  preTurnTranscript: AgentTranscriptMessage[],
): StepResult<ChatRunState> | null {
  return planTurnRetry(CHAT_STREAM_TIMEOUT_BUDGET, state, preTurnTranscript);
}

/**
 * Regenerate a brief / sub-agent boss turn that came back empty. Generic over
 * the run state so this module stays free of a `user-authored-brief` import;
 * the counter it reads is that workflow's `emptyRetries`.
 */
export function planEmptyBriefCompletionRetry<S extends { emptyRetries: number }>(
  state: S,
  preTurnTranscript: AgentTranscriptMessage[],
): StepResult<S> | null {
  return planTurnRetry(
    {
      max: EMPTY_COMPLETION_MAX_RETRIES,
      read: (s: S) => s.emptyRetries,
      bump: (s: S) => ({ ...s, emptyRetries: s.emptyRetries + 1 }),
      nextStep: "boss-turn",
    },
    state,
    preTurnTranscript,
  );
}
