import type { AgentTranscriptMessage, ChatModelTier } from "@alfred/contracts";
import type { StepResult } from "../registry";

/** Every bound on how much work one agent turn loop may do. */

/**
 * Chat turn-loop cap per tier. A user is watching, so a stuck loop must answer soon.
 * A lazy tool load costs two steps, so a real multi-sender ask needs this much room.
 * At the cap the turn answers; it does not fail.
 */
const CHAT_TURN_CAP_BY_TIER = {
  standard: 40,
  deep: 60,
} as const satisfies Record<ChatModelTier, number>;

/**
 * `land` is the first turn at the cap: no tools, and the landing note is appended.
 * `landed` is a later turn: still no tools.
 * No hard stop past the cap: with no tools the loop cannot continue, and each retry source has its
 * own bound.
 */
export type ChatTurnCapVerdict = "loop" | "land" | "landed";

export function chatTurnCapVerdict(
  tier: ChatModelTier,
  completedTurns: number,
): ChatTurnCapVerdict {
  const cap = CHAT_TURN_CAP_BY_TIER[tier];

  if (completedTurns < cap) return "loop";

  return completedTurns === cap ? "land" : "landed";
}

export function chatTurnCap(tier: ChatModelTier): number {
  return CHAT_TURN_CAP_BY_TIER[tier];
}

/** Tells the model why it has no tools and what the reply must contain. */
export const CHAT_TURN_CAP_LANDING_NOTE =
  "You have used every tool step available for this reply, so no tools are offered on this turn. " +
  "Answer the user now from what is already in this conversation. Say plainly what you completed and what is still left, in user terms. " +
  "Do not claim anything you did not finish, and do not describe the step limit or the mechanism. If work remains, tell the user they can ask you to continue.";

/**
 * Turn-loop cap for the brief and sub-agent workflow. It is lower than chat because a brief fails
 * at the cap.
 */
export const BRIEF_TURN_CAP_MAX = 30;

/**
 * A provider fallback sometimes returns an empty completion; a retry usually clears it.
 * Kept small so a provider stuck on empties fails fast.
 */
const EMPTY_COMPLETION_MAX_RETRIES = 2;

/** Only one: each timeout retry can cost a full stream ceiling (~180s) while the user waits. */
const STREAM_TIMEOUT_MAX_RETRIES = 1;

interface TurnRetryBudget<S> {
  readonly max: number;
  readonly read: (state: S) => number;
  /** Return a copy; never mutate the checkpoint state. */
  readonly bump: (state: S) => S;
  readonly nextStep: string;
}

interface PlannedTurnRetry<S> {
  readonly step: Extract<StepResult<S>, { kind: "next" }>;
  /** 1-based. */
  readonly attempt: number;
  readonly max: number;
}

/**
 * Plan one retry, or `null` once the budget is spent.
 * Retry from the transcript before the failed call: the failed call appends an empty
 * assistant message, and Anthropic rejects that with a 400.
 */
function planTurnRetry<S>(
  budget: TurnRetryBudget<S>,
  state: S,
  preTurnTranscript: AgentTranscriptMessage[],
): PlannedTurnRetry<S> | null {
  const spent = budget.read(state);

  if (spent >= budget.max) return null;

  return {
    step: {
      kind: "next",
      state: budget.bump(state),
      transcript: preTurnTranscript,
      nextStep: budget.nextStep,
    },
    attempt: spent + 1,
    max: budget.max,
  };
}

/** The chat counters, as a type so this module does not import `ChatRunState`. */
type ChatRetryState = {
  emptyCompletionRetries: number;
  streamTimeoutRetries: number;
  capacityRetries: number;
};

/** Zero every chat failure counter in place, after a turn that made progress. */
export function resetChatTurnRetryBudgets<S extends ChatRetryState>(state: S): void {
  state.emptyCompletionRetries = 0;
  state.streamTimeoutRetries = 0;
  state.capacityRetries = 0;
}

export interface ChatTurnRetries {
  readonly afterEmptyCompletion: <S extends ChatRetryState>(state: S) => PlannedTurnRetry<S> | null;
  readonly afterStreamTimeout: <S extends ChatRetryState>(state: S) => PlannedTurnRetry<S> | null;
  /**
   * Retry a 429 or 5xx that failed before streaming, after the caller waits out
   * {@link CAPACITY_RETRY_DELAYS_MS}. The gateway refills slowly, so fast retries cannot land.
   */
  readonly afterCapacityError: <S extends ChatRetryState>(state: S) => PlannedTurnRetry<S> | null;
}

/** The longest silence (30s plus jitter) must stay under the client's 45s SSE watchdog. */
export const CAPACITY_RETRY_DELAYS_MS = [10_000, 20_000, 30_000] as const;

export const CAPACITY_RETRY_JITTER_MS = 5_000;

const CAPACITY_MAX_RETRIES = 3;

/**
 * Bind the retry planners to the transcript before the model call.
 * Call it before the response is appended; the failure sites then cannot pass a poisoned
 * transcript.
 */
export function openChatTurnRetries(preTurnTranscript: AgentTranscriptMessage[]): ChatTurnRetries {
  return {
    afterEmptyCompletion: (state) =>
      planTurnRetry(
        {
          max: EMPTY_COMPLETION_MAX_RETRIES,
          read: (s) => s.emptyCompletionRetries,
          bump: (s) => ({ ...s, emptyCompletionRetries: s.emptyCompletionRetries + 1 }),
          nextStep: "chat-turn",
        },
        state,
        preTurnTranscript,
      ),
    afterStreamTimeout: (state) =>
      planTurnRetry(
        {
          max: STREAM_TIMEOUT_MAX_RETRIES,
          read: (s) => s.streamTimeoutRetries,
          bump: (s) => ({ ...s, streamTimeoutRetries: s.streamTimeoutRetries + 1 }),
          nextStep: "chat-turn",
        },
        state,
        preTurnTranscript,
      ),
    afterCapacityError: (state) =>
      planTurnRetry(
        {
          max: CAPACITY_MAX_RETRIES,
          read: (s) => s.capacityRetries,
          bump: (s) => ({ ...s, capacityRetries: s.capacityRetries + 1 }),
          nextStep: "chat-turn",
        },
        state,
        preTurnTranscript,
      ),
  };
}

export interface BriefTurnRetries {
  readonly afterEmptyCompletion: <S extends { emptyRetries: number }>(
    state: S,
  ) => PlannedTurnRetry<S> | null;
}

/** Like {@link openChatTurnRetries}: call it before `agent.turn`. */
export function openBriefTurnRetries(
  preTurnTranscript: AgentTranscriptMessage[],
): BriefTurnRetries {
  return {
    afterEmptyCompletion: (state) =>
      planTurnRetry(
        {
          max: EMPTY_COMPLETION_MAX_RETRIES,
          read: (s) => s.emptyRetries,
          bump: (s) => ({ ...s, emptyRetries: s.emptyRetries + 1 }),
          nextStep: "boss-turn",
        },
        state,
        preTurnTranscript,
      ),
  };
}
