/**
 * Transient retry over one `authedFetch` call. Retries thrown transport errors and 429/5xx,
 * with capped exponential backoff and jitter. Only retry-safe requests may use it.
 *
 * Every thrown error is retried, the timeout `AbortError` too. A caller abort (Drive's
 * collect deadline) is also retried: each retry fails fast, but the backoff delays the throw.
 * To fix, classify the caller abort first, as `compact-with-retry.ts` does.
 */

import { withDefaults } from "@alfred/contracts";

export interface RetryPolicy {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff step; doubles each attempt. Default 250ms. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff wait. Default 4000ms. */
  maxDelayMs?: number;
}

/** Exported so other retry envelopes share the base instead of a bare `250`. */
export const RETRY_BASE_DELAY_MS = 250;

const DEFAULT_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: RETRY_BASE_DELAY_MS,
  maxDelayMs: 4_000,
};

/** Same rule as `HttpError.retryable`. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * RFC 9110 safe methods only. PUT and DELETE are idempotent but not free to repeat:
 * a retried DELETE that already landed returns 404. They must opt in per request.
 */
export function isRetrySafeMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();

  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `Retry-After` seconds to ms, capped at `maxDelayMs` so `Retry-After: 3600` cannot park a call
 * for an hour. Ignores the HTTP-date form.
 */
function retryAfterMs(res: Response, policy: Required<RetryPolicy>): number | null {
  const header = res.headers.get("retry-after");

  if (!header) return null;
  const seconds = Number(header);

  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.min(seconds * 1_000, policy.maxDelayMs);
}

function backoffMs(attempt: number, policy: Required<RetryPolicy>): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);

  // Full jitter, so retries do not hit the upstream in lockstep.
  return Math.random() * capped;
}

export interface FetchWithRetryOptions {
  /** Required: to not retry, do not call this. Fields still default. */
  policy: RetryPolicy;
}

/**
 * Returns the first success, or the last response when attempts run out, or rethrows
 * the last transport error. Does not read the body.
 */
export async function fetchWithRetry(
  send: () => Promise<Response>,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const policy = withDefaults(DEFAULT_POLICY, options.policy);

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const isLast = attempt === policy.maxAttempts;

    try {
      const res = await send();

      if (isLast || !isRetryableStatus(res.status)) return res;
      await sleep(retryAfterMs(res, policy) ?? backoffMs(attempt, policy));
    } catch (err) {
      if (isLast) throw err;
      lastError = err;
      await sleep(backoffMs(attempt, policy));
    }
  }

  // Unreachable; satisfies the type checker without a cast.
  throw lastError instanceof Error ? lastError : new Error("fetchWithRetry: exhausted");
}
