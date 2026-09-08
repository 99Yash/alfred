import type { AgentTranscriptMessage, ChatModelTier } from "@alfred/contracts";
import type { StepResult } from "../types";

/**
 * Every bound on how much work one agent turn-loop may do, in one place.
 *
 * Two of these used to be a constant named `TURN_CAP_MAX` declared in both
 * agent workflows with two different values (24 and 30); the retry planners were
 * three copies of the same six lines, each carrying its own paragraph of the
 * one rule that actually matters. Co-locating them makes the numbers
 * comparable, and {@link openChatTurnRetries} / {@link openBriefTurnRetries}
 * take the rule out of prose entirely: a workflow binds its pre-turn transcript
 * once, before the model call, and the failure sites have no transcript
 * argument left to get wrong.
 */

/**
 * Turn-loop cap for the interactive chat workflow, per model tier. A user is
 * watching this one stream, so a wedged loop has to land while they are still
 * willing to wait. Sized against a real turn (prod `run_tsevusjk1poq`): with
 * two steps per lazy tool load and one tool call per model step, a legitimate
 * thirteen-sender standing-instruction ask burned the old flat cap of 24 on
 * plumbing and never answered. `deep` buys more room because the user chose
 * the slower tier on purpose.
 *
 * The cap is where the turn *lands*, not where it crashes: see
 * {@link chatTurnCapVerdict}.
 */
const CHAT_TURN_CAP_BY_TIER = {
  standard: 40,
  deep: 60,
} as const satisfies Record<ChatModelTier, number>;

/**
 * What the chat step does with the model turn it is about to run, given how
 * many model turns the run has completed.
 *
 *  - `loop`: under the cap; offer the tool surface as usual.
 *  - `land`: the first turn at the cap. Offer no tools, append the landing
 *    note, log `chat_turn_cap_landing`. The model must answer from what the
 *    transcript already holds.
 *  - `landed`: a later turn past the cap. Still no tools; the note is already
 *    in the transcript. Every turn here is issued by a spender with its own
 *    bound: an empty-completion or stream-timeout retry (the budgets below), a
 *    finalize guard's one regeneration, or a resume from a sub-agent park (one
 *    per child, each behind a dead-man timer).
 *
 * There is deliberately no hard fuse past the cap. With an empty tool set no
 * tool loop can continue, so nothing past `land` is the failure a cap exists
 * to stop, and every legitimate spender is already bounded. The number of
 * turns those spenders may legally add is not a constant (each regeneration
 * refreshes the retry budgets; a park resume repeats per child), so any fixed
 * grace would either fire on a legal path, losing a reply after every tool
 * write persisted, or be loose enough to guard nothing.
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

/** The tool-loop cap for a chat turn on `tier`, for the landing log line. */
export function chatTurnCap(tier: ChatModelTier): number {
  return CHAT_TURN_CAP_BY_TIER[tier];
}

/**
 * The transcript note the landing turn runs on, appended once by the `land`
 * verdict alongside an empty tool set: the model cannot call anything, and this
 * tells it why the loop ended and what the reply must now contain. Written via
 * `appendSystemNote`, so it joins a finalize guard's note when one is already
 * at the tail.
 */
export const CHAT_TURN_CAP_LANDING_NOTE =
  "You have used every tool step available for this reply, so no tools are offered on this turn. " +
  "Answer the user now from what is already in this conversation. Say plainly what you completed and what is still left, in user terms. " +
  "Do not claim anything you did not finish, and do not describe the step limit or the mechanism. If work remains, tell the user they can ask you to continue.";

/**
 * Turn-loop cap for the background brief / sub-agent workflow. Nobody is
 * watching it stream: an investigation is expected to work several distinct
 * angles, and the run has a compaction step it can spend turns on that the chat
 * path does not. Compare {@link chatTurnCapVerdict}: the chat cap is the higher
 * of the two on both tiers because a chat turn lands there instead of failing.
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
 * Module-private: a planned retry reports its own `attempt`/`max`, so no
 * workflow needs the number to write its log line.
 */
const EMPTY_COMPLETION_MAX_RETRIES = 2;

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
const STREAM_TIMEOUT_MAX_RETRIES = 1;

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
 * One planned retry: the step to return from the workflow, plus the counters
 * its log line needs. Carrying `attempt`/`max` here is why no workflow imports
 * a budget constant — reporting progress was the only thing they were for.
 */
interface PlannedTurnRetry<S> {
  readonly step: Extract<StepResult<S>, { kind: "next" }>;
  /** 1-based, so an operator reads `retry 1/2`. */
  readonly attempt: number;
  readonly max: number;
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
 * Private: the transcript reaches this only from a handle bound before the
 * model call (see {@link openChatTurnRetries}), so no caller is ever holding a
 * post-turn transcript and a retry planner at the same time.
 *
 * Pure, so both the budget and the poison-transcript regression are directly
 * testable.
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

/**
 * The two consecutive-failure counters a chat turn budgets. Named as a type so
 * this module — which stays in `agent` — does not import the concrete
 * `ChatRunState` that moved to `chat`. The chat planners are generic
 * over it, exactly like {@link openBriefTurnRetries} is over its own counter.
 */
type ChatRetryState = {
  emptyCompletionRetries: number;
  streamTimeoutRetries: number;
};

/**
 * Zero every chat consecutive-failure counter, in place.
 *
 * The counters bound *consecutive* failures, so any turn that made progress —
 * one that produced tool calls, and one that reached the finalize boundary with
 * text — hands the next turn a fresh budget. Both of those sites used to write
 * the two field assignments out longhand, which is how a third budget gets one
 * of them and not the other; here a new budget zeroes its counter once, next to
 * the descriptor that reads and bumps it.
 */
export function resetChatTurnRetryBudgets<S extends ChatRetryState>(state: S): void {
  state.emptyCompletionRetries = 0;
  state.streamTimeoutRetries = 0;
}

/** Every bounded retry a chat turn can plan, bound to one pre-turn transcript. */
export interface ChatTurnRetries {
  /** Regenerate a turn that came back empty. */
  readonly afterEmptyCompletion: <S extends ChatRetryState>(state: S) => PlannedTurnRetry<S> | null;
  /**
   * Regenerate a turn the streaming circuit-breaker aborted. The bound
   * transcript already holds every tool result gathered this run, so the retry
   * re-issues just the model call that ran long — exactly like the manual
   * resend that recovers today.
   */
  readonly afterStreamTimeout: <S extends ChatRetryState>(state: S) => PlannedTurnRetry<S> | null;
}

/**
 * Bind the chat turn's retry planners to the transcript as it stood *before*
 * the model call about to be issued.
 *
 * Call this in the workflow at the point the pre-turn transcript is final and
 * the response has not been appended yet — that placement is the guarantee.
 * The planners returned take no transcript, so the failure sites downstream
 * (which do hold a post-turn transcript) have nothing to pass and no way to
 * poison the retry; see {@link planTurnRetry} for what a poisoned retry costs.
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
  };
}

/** Every bounded retry a brief / sub-agent boss turn can plan. */
export interface BriefTurnRetries {
  /**
   * Regenerate a boss turn that came back empty. Generic over the run state so
   * this module stays free of a `user-authored-brief` import; the counter it
   * reads is that workflow's `emptyRetries`.
   */
  readonly afterEmptyCompletion: <S extends { emptyRetries: number }>(
    state: S,
  ) => PlannedTurnRetry<S> | null;
}

/**
 * Bind the brief workflow's retry planner to its pre-turn transcript. Same
 * placement rule as {@link openChatTurnRetries}: mint it before `agent.turn`.
 */
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
