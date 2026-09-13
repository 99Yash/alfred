import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";

/**
 * True for a caller-initiated cancel — `AbortController.abort()`, which Node
 * surfaces as a `DOMException` named `AbortError`.
 *
 * Deliberately does NOT match `TimeoutError` (what `AbortSignal.timeout()` and
 * the AI SDK's `timeout` option produce): a timeout is the provider failing to
 * answer, an abort is us deciding we no longer want the answer, and the two
 * want opposite handling everywhere they meet — `withFallback` treats a timeout
 * as switch-worthy and drops an abort; `metered()` logs a timeout as an error
 * row and an abort as a cancelled one. (Switch-worthy is not the same as
 * recoverable: a caller-supplied *total* timeout expires the signal the
 * fallback attempt would share, so only a per-attempt timeout leaves budget for
 * the fallback to actually answer.)
 *
 * Duplicates `ai-retry`'s internal predicate. Its `error.isAbort()` is exported
 * only as a *condition* (a retry-list entry), and the carve-out we need is a
 * negation inside a custom `error()` callback, which a condition object can't
 * express — hence a local copy rather than a reuse.
 */
export function isCallerAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Deepest useful transport error: the outer `APICallError` when the call
 * failed on its first attempt, else the most recent `APICallError` inside a
 * `RetryError`'s attempt list. A multi-attempt failure through `withFallback`
 * throws ai-retry's `RetryError` wrapping every attempt's error — the status
 * and body sit on `lastError` / `errors`, never on the outer object — so any
 * reader that branches on transport facts must unwrap here rather than match
 * the outer error. Single home for the walk: `metered()` and the capacity
 * predicate in `./provider` share it instead of each carrying a copy.
 */
export function findApiCallError(err: unknown): APICallError | undefined {
  if (APICallError.isInstance(err)) return err;

  if (RetryError.isInstance(err)) {
    const errors = err.errors;

    if (Array.isArray(errors)) {
      for (let i = errors.length - 1; i >= 0; i--) {
        const candidate = errors[i];

        if (APICallError.isInstance(candidate)) return candidate;
      }
    }

    if (APICallError.isInstance(err.lastError)) return err.lastError;
  }

  return undefined;
}
