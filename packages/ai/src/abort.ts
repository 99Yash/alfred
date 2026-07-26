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
