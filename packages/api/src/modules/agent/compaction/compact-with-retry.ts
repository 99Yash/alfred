import { toMessage } from "@alfred/contracts";
import type { CompactTranscriptResult } from "./compactor";

/**
 * Bounded retry around a compactor call.
 *
 * Both sites that compact a run transcript — the brief workflow's
 * `compact-transcript` step and the chat path's within-run context guard — had
 * their own copy of the same skeleton: a bounded loop, `break` on success,
 * rethrow the fatal classes, and a `compactor_failed: <last error>` throw when
 * every attempt was exhausted. The two differ in exactly two ways, and both are
 * options here rather than something a copy can silently get wrong — the one
 * whose wrong answer costs money is required, the one whose wrong answer costs
 * only latency is optional.
 */
const COMPACTOR_RETRY_ATTEMPTS = 3;

export interface CompactWithRetryOptions {
  /**
   * The abort signal of the turn being compacted, or `"none"` for a caller that
   * genuinely has none (the background brief step).
   *
   * Required, and deliberately not a boolean or an optional predicate: a
   * compactor call is full-price, so a loop that keeps retrying after the user
   * hit Stop spends real money on a turn nobody is waiting for. Making the
   * answer optional would let a new caller buy that by writing less, which is
   * the wrong default. `"none"` is a caller stating it has no signal, not
   * forgetting to pass one.
   */
  abortSignal: AbortSignal | "none";
  /**
   * Wait between attempts. The brief workflow backs off (`attempt * 100`ms) — it
   * runs in the background, where riding out a transient provider blip is worth
   * the delay. The chat guard passes nothing: it is holding up a live turn, so
   * an immediate re-attempt is the only affordable retry. Optional because
   * omitting it costs latency resilience, not money.
   */
  delayBeforeRetryMs?: (attempt: number) => number;
}

/**
 * Run `compact` up to {@link COMPACTOR_RETRY_ATTEMPTS} times, returning the
 * first success.
 *
 * `compact` receives the 1-based attempt number so callers can keep their
 * per-attempt idempotency key distinct (the same key on a retry would return the
 * first attempt's cached failure). Throws the underlying error once the turn is
 * aborted or the compactor refuses the input, or `compactor_failed: <last error
 * message>` when the budget is spent.
 *
 * An abort ends the loop on the failed attempt AND before any re-attempt, so
 * neither the error path nor the backoff window can leak a paid call into a
 * stopped turn.
 */
export async function compactWithRetry(
  compact: (attempt: number) => Promise<CompactTranscriptResult>,
  options: CompactWithRetryOptions,
): Promise<CompactTranscriptResult> {
  const aborted = (): boolean => options.abortSignal !== "none" && options.abortSignal.aborted;
  let lastError: unknown;
  for (let attempt = 1; attempt <= COMPACTOR_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && aborted()) throw lastError;
    try {
      return await compact(attempt);
    } catch (error) {
      lastError = error;
      if (isCompactorInputTooLarge(error) || aborted()) throw error;
      const delayMs = options.delayBeforeRetryMs?.(attempt) ?? 0;
      if (attempt < COMPACTOR_RETRY_ATTEMPTS && delayMs > 0) await sleepMs(delayMs);
    }
  }
  throw new Error(`compactor_failed: ${toMessage(lastError)}`);
}

/**
 * The one fatal class every caller shares: the compactor refusing an input it
 * cannot fit. Not retryable by construction — the input does not shrink between
 * attempts.
 */
function isCompactorInputTooLarge(error: unknown): boolean {
  return toMessage(error) === "compactor_input_too_large";
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
