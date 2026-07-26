/**
 * Hedged requests for the triage classify call (#436, under epic #435).
 *
 * The epic measured `triage.classify` in production: the median is ~1.9s —
 * essentially the cheap-model floor — but p90 is ~8s, p95 ~10–12s, and the max
 * 28s. Fast and slow calls carry *identical* token counts, so the tail is not
 * work, it is Google-side scheduling jitter. That is the textbook hedged-request
 * case: once a call has run past the point where a healthy call would already
 * have answered, the cheapest way to recover the tail is to ask again and take
 * whichever draw lands first.
 *
 * Safety rests on the classify call being **idempotent and interchangeable**:
 * `temperature: 0` plus a fixed structured-output schema, so the two draws are
 * two samples of the same distribution and first-wins cannot trade tagging
 * precision for latency (the constraint epic #435 locks).
 *
 * Deliberately NOT a shared util: the delay, the "settle-before-the-timer wins"
 * rule, and the willingness to pay twice are a policy calibrated to one call
 * site's latency histogram, so it colocates with its consumer.
 *
 * Two behaviours worth stating because they are easy to get wrong:
 *
 *  - **A hedge is not a retry.** If the first attempt *fails* before the timer
 *    fires, that failure is the answer — no second call. Retry/degrade is
 *    ai-retry's job inside `withFallback`, and duplicating it here would bill a
 *    second call on a path that already has one.
 *  - **The loser is cancelled, and the cancel must not degrade.** Aborting the
 *    loser used to look like a transient provider fault to `withFallback`'s
 *    `shouldSwitch`, which would have re-issued it on `gemini-2.5-flash`. The
 *    abort carve-out in `@alfred/ai`'s `withFallback` is what makes cancelling
 *    safe; this module depends on it.
 */

/** Which of the two draws this invocation is. `0` is the original call. */
export type HedgeAttempt = 0 | 1;

export interface HedgeAttemptInput {
  attempt: HedgeAttempt;
  /**
   * Aborted as soon as the *other* attempt wins. Callers must forward it to the
   * underlying request; a hedge that cannot be cancelled is just double spend.
   */
  signal: AbortSignal;
}

export interface RunHedgedOptions<T> {
  /**
   * How long to wait for the first attempt before firing the second. Should sit
   * around p75 of the healthy distribution: high enough that the common fast
   * call never duplicates, low enough to still cut the tail. Anything `<= 0`
   * (or non-finite) disables hedging entirely and runs a single attempt.
   */
  delayMs: number;
  run: (input: HedgeAttemptInput) => Promise<T>;
}

type Settled<T> =
  | { attempt: HedgeAttempt; ok: true; value: T }
  | { attempt: HedgeAttempt; ok: false; error: unknown };

/** Reflect a promise so a loser's rejection is always handled (never unhandled). */
function settle<T>(attempt: HedgeAttempt, promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ attempt, ok: true, value }) as const,
    (error: unknown) => ({ attempt, ok: false, error }) as const,
  );
}

/**
 * Run `run` once; if it has not settled within `delayMs`, run it a second time
 * and resolve with whichever attempt **succeeds** first, aborting the other.
 *
 * Failure semantics: if both attempts fail, the *first* attempt's error is
 * thrown regardless of which failed first — it is the one the caller would have
 * seen without hedging, so hedging never changes the error a caller handles.
 */
export async function runHedged<T>(opts: RunHedgedOptions<T>): Promise<T> {
  const { delayMs, run } = opts;

  const primaryController = new AbortController();
  const primary = settle(0, run({ attempt: 0, signal: primaryController.signal }));

  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return unwrap(await primary);
  }

  const HEDGE = Symbol("hedge");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<typeof HEDGE>((resolve) => {
    timer = setTimeout(() => resolve(HEDGE), delayMs);
  });

  let raced: Settled<T> | typeof HEDGE;
  try {
    raced = await Promise.race([primary, elapsed]);
  } finally {
    clearTimeout(timer);
  }

  // The first attempt settled inside the window — success or failure, that is
  // the answer, and no second call is made.
  if (raced !== HEDGE) return unwrap(raced);

  const hedgeController = new AbortController();
  const hedge = settle(1, run({ attempt: 1, signal: hedgeController.signal }));

  const first = await Promise.race([primary, hedge]);
  if (first.ok) {
    (first.attempt === 0 ? hedgeController : primaryController).abort();
    return first.value;
  }

  // The first *settled* attempt failed; the other one is still the live answer.
  // Nothing to abort on this path — the loser already ended on its own.
  const second = await (first.attempt === 0 ? hedge : primary);
  if (second.ok) return second.value;

  throw (first.attempt === 0 ? first : second).error;
}

function unwrap<T>(result: Settled<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}
