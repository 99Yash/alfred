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
 * header is honored when present. A caller-driven abort is never retried.
 *
 * SAFETY: only the caller decides *which requests* are eligible — this must be
 * used for idempotent reads (GET/HEAD) unless the write carries an idempotency
 * key, so a retried request can never double-apply a side effect.
 */

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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** `Retry-After` in seconds (delta form) → ms; ignores the HTTP-date form. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

function backoffMs(attempt: number, policy: Required<RetryPolicy>): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Full jitter (AWS) — spread retries so a fleet doesn't reconverge on the
  // upstream in lockstep. Runtime code, so `Math.random` is fine here.
  return Math.random() * capped;
}

export interface FetchWithRetryOptions {
  policy?: RetryPolicy;
  /** Classify a returned (non-thrown) response as retryable. Default {@link isRetryableStatus}. */
  retryable?: (res: Response) => boolean;
  /** Caller abort — a signalled abort is surfaced immediately, never retried. */
  signal?: AbortSignal;
}

/**
 * Send `send()` with transient retry. Returns the first success, the last
 * response once attempts are exhausted (the caller still classifies a final
 * non-2xx), or rethrows the last transport error. A body is never read here —
 * the returned `Response` reaches the caller unconsumed.
 */
export async function fetchWithRetry(
  send: () => Promise<Response>,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const retryable = options.retryable ?? ((res) => isRetryableStatus(res.status));

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const isLast = attempt === policy.maxAttempts;
    try {
      const res = await send();
      if (isLast || !retryable(res)) return res;
      await sleep(retryAfterMs(res) ?? backoffMs(attempt, policy), options.signal);
    } catch (err) {
      // A caller-driven abort is intentional — do not retry it.
      if (options.signal?.aborted) throw err;
      if (isLast) throw err;
      lastError = err;
      await sleep(backoffMs(attempt, policy), options.signal);
    }
  }
  // Unreachable: the loop returns or throws on the last attempt. Satisfy the
  // type checker without a cast.
  throw lastError instanceof Error ? lastError : new Error("fetchWithRetry: exhausted");
}
