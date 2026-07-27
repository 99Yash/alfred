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
 * parameters here rather than something a copy can silently get wrong.
 */
const COMPACTOR_RETRY_ATTEMPTS = 3;

export interface CompactWithRetryOptions {
  /** How many total attempts to make. Defaults to {@link COMPACTOR_RETRY_ATTEMPTS}. */
  attempts?: number;
  /**
   * Errors that must NOT be retried, rethrown as-is on the attempt that raised
   * them. `compactor_input_too_large` always qualifies — retrying an input the
   * compactor already refused just spends another full-price call on the same
   * refusal — so callers only declare what they add on top. The chat guard adds
   * "the turn was aborted": a stop request must abandon the loop immediately
   * rather than burn two more compactor calls on a turn nobody is waiting for.
   */
  isFatal?: (error: unknown) => boolean;
  /**
   * Wait between attempts. The brief workflow backs off (`attempt * 100`ms) — it
   * runs in the background, where riding out a transient provider blip is worth
   * the delay. The chat guard passes nothing: it is holding up a live turn, so
   * an immediate re-attempt is the only affordable retry.
   */
  delayBeforeRetryMs?: (attempt: number) => number;
}

/**
 * Run `compact` up to `attempts` times, returning the first success.
 *
 * `compact` receives the 1-based attempt number so callers can keep their
 * per-attempt idempotency key distinct (the same key on a retry would return the
 * first attempt's cached failure). Throws the underlying error for a fatal
 * class, or `compactor_failed: <last error message>` once the budget is spent.
 */
export async function compactWithRetry(
  compact: (attempt: number) => Promise<CompactTranscriptResult>,
  options: CompactWithRetryOptions = {},
): Promise<CompactTranscriptResult> {
  const attempts = options.attempts ?? COMPACTOR_RETRY_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await compact(attempt);
    } catch (error) {
      lastError = error;
      if (isCompactorInputTooLarge(error) || options.isFatal?.(error) === true) throw error;
      const delayMs = options.delayBeforeRetryMs?.(attempt) ?? 0;
      if (attempt < attempts && delayMs > 0) await sleepMs(delayMs);
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
