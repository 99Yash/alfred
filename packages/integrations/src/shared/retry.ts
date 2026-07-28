/**
 * The transient-retry transform every integration client can compose over the
 * bare {@link authedFetch} transport — the piece Effect's `HttpClient` gives you
 * as `retryTransient` and that this package was missing entirely (the
 * `HttpError.retryable` getter existed but nothing ever consumed it).
 *
 * It is a *wrapper over a request thunk*, not a change to the transport core:
 * `authedFetch` stays a single honest round-trip, and a client opts in by
 * sending through {@link fetchWithRetry}. This keeps retry a client policy
 * (composed in one place, per provider) rather than a hidden property of every
 * call.
 *
 * Two transient conditions are retried, both with capped exponential backoff +
 * jitter: a thrown transport failure (timeout/DNS/reset/TLS) and a retryable
 * status ({@link isRetryableStatus}: 429 or 5xx). A `429`/`503` `Retry-After`
 * header is honored when present, bounded by the policy's `maxDelayMs` so an
 * upstream-supplied delay can shorten but never exceed the caller's budget.
 *
 * This module is NOT on the `@alfred/integrations/shared` barrel (only
 * {@link RetryPolicy} is). Retry is an internal composition detail of
 * `defineProviderClient`, which is the only file that imports it; the configured
 * client is the public door.
 *
 * SAFETY: only the caller decides *which requests* are eligible — this must be
 * used for idempotent reads (GET/HEAD) unless the write carries an idempotency
 * key, so a retried request can never double-apply a side effect. That rule is
 * enforceable, not just documented: a transport that dispatches by method gates
 * on {@link isRetrySafeMethod} and makes anything else opt in explicitly (see
 * `defineProviderClient`).
 *
 * CANCELLATION: there is none, by deliberate omission. Every thrown transport
 * error is retried, including the `AbortError` from `authedFetch`'s own
 * `AbortSignal.timeout` — which is correct, because that timeout IS the transient
 * failure this loop exists to absorb. There is no caller-driven abort to confuse
 * it with today: no reachable caller can supply a signal.
 *
 * That changes the moment one can. `TODO(#286)` threads a per-run `AbortSignal`
 * through the dispatcher that builds these binds, and the repo's `AbortSignal.any`
 * idiom makes a user's "Stop" indistinguishable from a timeout once inside
 * `fetch`. So a caller-driven abort must be classified BEFORE the retry decision,
 * or one Stop becomes `maxAttempts` more upstream requests. Re-adding a bare
 * optional field is not enough; take the tree's settled shape for this — the
 * required `abortSignal: AbortSignal | "none"` on
 * `api/src/modules/agent/compaction/compact-with-retry.ts`.
 */

import { withDefaults } from "@alfred/contracts";

/** Tunable backoff envelope; every field has a sane default. */
export interface RetryPolicy {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff step; doubles each attempt. Default 250ms. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff wait. Default 4000ms. */
  maxDelayMs?: number;
}

const DEFAULT_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/** Rate-limited (429) or a transient upstream 5xx — the same rule as `HttpError.retryable`. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * The HTTP methods a transport may retry WITHOUT knowing anything else about the
 * request: the [RFC 9110 safe methods](https://www.rfc-editor.org/rfc/rfc9110.html#name-safe-methods),
 * which by definition apply no side effect to re-apply.
 *
 * Deliberately narrower than RFC 9110's *idempotent* set (which also admits PUT
 * and DELETE): idempotent means a repeat leaves the same STATE, not that the
 * repeat is free — a retried DELETE whose first attempt actually landed answers
 * `404`, and a caller that reads the status will draw the wrong conclusion. So
 * PUT/DELETE and anything carrying an idempotency key must opt in per request
 * rather than inherit retry from their method.
 */
export function isRetrySafeMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `Retry-After` in seconds (delta form) → ms, BOUNDED by the policy's
 * `maxDelayMs`; ignores the HTTP-date form.
 *
 * The bound is the point. `Retry-After` is upstream-controlled, so an honest
 * `Retry-After: 3600` on a rate-limited GitHub read would otherwise park a tool
 * call for an hour — the retry envelope's own ceiling would be silently
 * overridden by a header. Capping it means the header can only ever *shorten*
 * the wait relative to the ceiling the caller configured; a wait longer than the
 * budget becomes an exhausted-retries error the caller can report, not a hang.
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
  // Full jitter (AWS) — spread retries so a fleet doesn't reconverge on the
  // upstream in lockstep. Runtime code, so `Math.random` is fine here.
  return Math.random() * capped;
}

export interface FetchWithRetryOptions {
  /**
   * The envelope, stated by the caller. Required: reaching this function at all is
   * a decision to retry, so there is no "unspecified" case to default. Individual
   * FIELDS still default ({@link DEFAULT_POLICY}) — those are tunables, not the
   * on/off switch. To not retry, don't call this.
   */
  policy: RetryPolicy;
}

/**
 * Send `send()` with transient retry. Returns the first success, the last
 * response once attempts are exhausted (the caller still classifies a final
 * non-2xx), or rethrows the last transport error. A body is never read here —
 * the returned `Response` reaches the caller unconsumed.
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
  // Unreachable: the loop returns or throws on the last attempt. Satisfy the
  // type checker without a cast.
  throw lastError instanceof Error ? lastError : new Error("fetchWithRetry: exhausted");
}
