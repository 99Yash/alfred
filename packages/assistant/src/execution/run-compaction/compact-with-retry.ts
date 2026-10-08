import { toMessage } from "@alfred/contracts";
import type { CompactTranscriptResult } from "./compactor";

const COMPACTOR_RETRY_ATTEMPTS = 3;

export interface CompactWithRetryOptions {
  /** Required: retries after Stop cost real money. `"none"` says the caller has no signal. */
  abortSignal: AbortSignal | "none";
  /** Omit it on a live turn, where only an immediate retry is affordable. */
  delayBeforeRetryMs?: (attempt: number) => number;
}

/**
 * Retry `compact` a bounded number of times. It gets the 1-based attempt, so each retry uses
 * a new idempotency key; a reused key returns the cached failure.
 * An abort stops both before and after the backoff.
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

/** Not retryable: the input does not shrink between attempts. */
function isCompactorInputTooLarge(error: unknown): boolean {
  return toMessage(error) === "compactor_input_too_large";
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
