/**
 * Hedged requests for triage classify (#436). The slow tail is provider jitter,
 * not work, so a slow call gets a twin and the first success wins. Safe because
 * `temperature: 0` makes the draws interchangeable. Kept here, not shared: the
 * policy fits one call site.
 *  - Not a retry: a failure before the timer is the answer.
 *  - The loser is cancelled; `withFallback` must not retry an abort.
 *  - The hedge has a budget ({@link createHedgeBudget}).
 */

/** `0` is the original call. */
export type HedgeAttempt = 0 | 1;

interface HedgeAttemptInput {
  attempt: HedgeAttempt;
  /** Forward to the request, or the loser is never cancelled and bills twice. */
  signal: AbortSignal;
}

export interface RunHedgedOptions<T> {
  /** About p75 of a healthy call. `<= 0` or non-finite disables hedging. */
  delayMs: number;
  /** Omit and every slow call hedges, which is wrong under load. */
  budget?: HedgeBudget;
  run: (input: HedgeAttemptInput) => Promise<T>;
}

/**
 * Cap on in-flight duplicate draws, process-wide. Under provider pressure most
 * calls pass p75, so unbounded hedging doubles load into a pool already
 * returning 429. Past the cap a call just waits, as if unhedged.
 */
export interface HedgeBudget {
  /** `false`: at the cap, do not duplicate. */
  tryAcquire(): boolean;
  /** Call exactly once per successful acquire. */
  release(): void;
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

/** A quarter of worker concurrency, at least one. The default 8 allows 2. */
export function hedgeCeilingFor(agentWorkerConcurrency: number): number {
  return Math.max(1, Math.floor(agentWorkerConcurrency / 4));
}

type Settled<T> =
  | { attempt: HedgeAttempt; ok: true; value: T }
  | { attempt: HedgeAttempt; ok: false; error: unknown };

/** Never rejects, so a loser's rejection is always handled. */
function settle<T>(attempt: HedgeAttempt, promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ attempt, ok: true, value }) as const,
    (error: unknown) => ({ attempt, ok: false, error }) as const,
  );
}

/**
 * Run once; if not settled within `delayMs`, run again and return the first success.
 * If both fail, throw the first attempt's error: the one an unhedged caller would see.
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

  if (raced !== HEDGE) return unwrap(raced);

  if (budget && !budget.tryAcquire()) return unwrap(await primary);

  const hedgeController = new AbortController();
  const hedge = settle(1, run({ attempt: 1, signal: hedgeController.signal }));
  // Release on settle, not on return: the cancelled loser may still be running.
  void hedge.then(() => budget?.release());

  const first = await Promise.race([primary, hedge]);

  if (first.ok) {
    (first.attempt === 0 ? hedgeController : primaryController).abort();

    return first.value;
  }

  const second = await (first.attempt === 0 ? hedge : primary);

  if (second.ok) return second.value;

  throw (first.attempt === 0 ? first : second).error;
}

function unwrap<T>(result: Settled<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}
