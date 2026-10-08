import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";

/**
 * A caller cancel (`AbortError`). Not a `TimeoutError`: a timeout is the provider failing,
 * so `withFallback` switches on it and `metered()` logs it as an error.
 * Copies ai-retry's `error.isAbort()`, which exists only as a retry condition.
 */
export function isCallerAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** The `APICallError` itself, or the newest one inside ai-retry's `RetryError`. */
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
