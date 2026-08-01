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
 *  - **A hedge has a budget.** The trigger correlates with exactly the state
 *    that makes duplication harmful — see {@link createHedgeBudget}.
 */

/** Which of the two draws this invocation is. `0` is the original call. */
export type HedgeAttempt = 0 | 1;

interface HedgeAttemptInput {
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
  /**
   * Process-wide ceiling on *simultaneous* duplicate draws. Omit and every slow
   * call hedges — fine for a single call in isolation, wrong under load. See
   * {@link createHedgeBudget}.
   */
  budget?: HedgeBudget;
  run: (input: HedgeAttemptInput) => Promise<T>;
}

/**
 * Ceiling on duplicate draws that may be in flight at once, process-wide.
 *
 * The hedge trigger is "this call is slower than p75", which is a per-call
 * judgement made without any notion of aggregate load — and the two are
 * correlated in the worst direction. #435's own data shows the tail clustering
 * on capacity-pressure days (2026-06-26: 28% of classify calls fell back;
 * 2026-07-03: 0%). Under capacity pressure *most* calls run past p75, so the
 * trigger fires broadly rather than for the slow ~15–20% the design assumed,
 * and the response — doubling the request rate into a pool that is already
 * 429ing — feeds the failure it exists to fix: more 429s → more `withFallback`
 * switches to `gemini-2.5-flash` → the slow expensive path #436 removed. The
 * eval already knows this and disables hedging so it "would only double the
 * pressure `maxRetries: 1` exists to relieve"; production during a morning
 * burst is the same regime.
 *
 * The literature's mechanism is a hedge budget (Dean & Barroso cap hedges at
 * ~5% of requests). This is the in-flight form of the same idea, which fits
 * what actually threatens the pool: a bound on *concurrent* duplicates, so the
 * worst case is `concurrency + ceiling` in-flight classify calls instead of
 * `2 × concurrency`. Requests past the ceiling simply don't duplicate — they
 * wait on their original draw, which is the pre-#436 behaviour, so exhausting
 * the budget degrades to "no hedging" rather than to an error.
 *
 * Not a shared util for the same reason the rest of this module isn't: the
 * ceiling is calibrated against one call site's histogram. It IS process-global
 * state, though, so it is created once by the consumer and passed in, rather
 * than being a module-level counter here that tests can't isolate.
 */
export interface HedgeBudget {
  /** Reserve a slot. `false` means the ceiling is reached — do not duplicate. */
  tryAcquire(): boolean;
  /** Return a slot. Must be called exactly once per successful acquire. */
  release(): void;
  /** Duplicate draws currently in flight. For assertions and instrumentation. */
  inFlight(): number;
}

export function createHedgeBudget(maxInFlight: number): HedgeBudget {
  const ceiling = Math.max(0, Math.floor(maxInFlight));
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= ceiling) return false;
      inFlight += 1;
      return true;
    },
    release() {
      if (inFlight > 0) inFlight -= 1;
    },
    inFlight() {
      return inFlight;
    },
  };
}

/**
 * How many duplicate draws a process running `agentWorkerConcurrency` agent
 * steps may have in flight: a quarter of them, at least one.
 *
 * Tying it to the worker's concurrency rather than to a fresh env knob keeps
 * the "how much load can this process make" question answered in one place
 * (see `@alfred/env/pool`, which sizes the DB pool from the same number). At
 * the default 8 this allows 2, so a saturated process issues at most 10
 * concurrent classify calls rather than 16.
 */
export function hedgeCeilingFor(agentWorkerConcurrency: number): number {
  return Math.max(1, Math.floor(agentWorkerConcurrency / 4));
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
 *
 * With a `budget`, a slow call whose process is already at its duplicate
 * ceiling just keeps waiting on the original — no error, no second call.
 */
export async function runHedged<T>(opts: RunHedgedOptions<T>): Promise<T> {
  const { delayMs, budget, run } = opts;

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

  // Out of duplicate budget: the process is already making as much extra load
  // as it is allowed to. Wait on the original — exactly the un-hedged path.
  if (budget && !budget.tryAcquire()) return unwrap(await primary);

  const hedgeController = new AbortController();
  const hedge = settle(1, run({ attempt: 1, signal: hedgeController.signal }));
  // Release on settle, not on return: the slot tracks a live duplicate call,
  // and the winner returns while the cancelled loser is still unwinding.
  // `settle` never rejects, so this can't produce an unhandled rejection.
  void hedge.then(() => budget?.release());

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
