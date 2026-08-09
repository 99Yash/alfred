import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createHedgeBudget,
  hedgeCeilingFor,
  runHedged,
  type HedgeAttempt,
  type HedgeBudget,
} from "@alfred/assistant/triage/hedge";

/**
 * Hedged classify (#436). The tail of `triage.classify` is provider scheduling
 * jitter, so a duplicate draw recovers p90/p95 — but only if four properties
 * hold, and each of them is a way to burn money or precision if it doesn't:
 *
 *  - a fast call never duplicates (otherwise every classify costs double);
 *  - a slow call does, and the faster draw wins;
 *  - the loser is actually cancelled (an uncancelled hedge is pure spend);
 *  - a hedge is not a retry — a failure inside the window is the answer.
 */

const DELAY = 20;

/** Deterministic scheduling: resolve after `ms`, or reject early if aborted. */
function after<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

interface Recorder {
  attempts: HedgeAttempt[];
  aborted: HedgeAttempt[];
}

function recorder(): Recorder {
  return { attempts: [], aborted: [] };
}

/** Track which attempts ran and which of them were cancelled. */
function track(rec: Recorder, attempt: HedgeAttempt, signal: AbortSignal): void {
  rec.attempts.push(attempt);
  signal.addEventListener("abort", () => rec.aborted.push(attempt));
}

interface CeilingHarness {
  /** Pass this to `runHedged` in place of the raw budget. */
  budget: HedgeBudget;
  /** Resolves once every caller has decided whether to duplicate. */
  decided: Promise<void>;
  /** Resolves once every granted duplicate has produced its answer. */
  answered: Promise<void>;
  /** Call from a hedge draw, just before it resolves. */
  hedgeSettled(): void;
}

/**
 * Sequencing for the concurrent-ceiling case, built out of counted events
 * rather than durations.
 *
 * Elapsed time cannot separate "all five callers decided" from "a hedge settled
 * and released its slot". On a loaded runner the five `delayMs` timers land in
 * different millisecond buckets, the event loop turns between them, and a short
 * hedge settles in the middle of the decisions — at which point a later caller
 * takes the freed slot, a cumulative count of 3 becomes correct behaviour, and
 * the test fails while the code is right. This was the single largest source of
 * red builds on `main`, so the case is sequenced on `tryAcquire`, which
 * `runHedged` calls exactly once per caller that reaches the hedge point: for
 * the ones that win a slot and for the ones the ceiling turns away.
 *
 * `answered` waits for the duplicates that were actually GRANTED, never for a
 * fixed two. A mutant that grants none would otherwise leave every original
 * waiting on a hedge that never runs, and the case would hang to the job
 * timeout instead of failing.
 */
function ceilingHarness(callers: number, inner: HedgeBudget): CeilingHarness {
  // Both executors run synchronously, so the openers are assigned before
  // `tryAcquire` can reach them.
  let openDecided = (): void => {};
  const decided = new Promise<void>((resolve) => {
    openDecided = () => resolve();
  });
  let openAnswered = (): void => {};
  const answered = new Promise<void>((resolve) => {
    openAnswered = () => resolve();
  });

  let decisions = 0;
  let granted = 0;
  let settled = 0;

  // Only meaningful once every caller has decided: until then `granted` is
  // still climbing, so an early equality would open the gate on a prefix.
  const openWhenAllGrantedHaveAnswered = (): void => {
    if (decisions >= callers && settled >= granted) openAnswered();
  };

  return {
    budget: {
      tryAcquire() {
        const acquired = inner.tryAcquire();
        decisions += 1;
        if (acquired) granted += 1;
        if (decisions >= callers) {
          openDecided();
          openWhenAllGrantedHaveAnswered();
        }
        return acquired;
      },
      release: () => inner.release(),
      inFlight: () => inner.inFlight(),
    },
    decided,
    answered,
    hedgeSettled() {
      settled += 1;
      openWhenAllGrantedHaveAnswered();
    },
  };
}

describe("runHedged", () => {
  test("a fast first attempt answers alone — no duplicate call", async () => {
    const rec = recorder();

    const result = await runHedged({
      delayMs: DELAY,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return after(1, "fast", signal);
      },
    });

    assert.equal(result, "fast");
    assert.deepEqual(rec.attempts, [0], "the hedge must not fire for a fast call");
  });

  test("a slow first attempt is hedged, and the faster draw wins", async () => {
    const rec = recorder();

    const result = await runHedged({
      delayMs: DELAY,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return attempt === 0 ? after(10_000, "slow", signal) : after(1, "hedge", signal);
      },
    });

    assert.equal(result, "hedge");
    assert.deepEqual(rec.attempts, [0, 1]);
  });

  test("the losing draw is aborted once its twin answers", async () => {
    const rec = recorder();

    await runHedged({
      delayMs: DELAY,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return attempt === 0 ? after(10_000, "slow", signal) : after(1, "hedge", signal);
      },
    });

    assert.deepEqual(rec.aborted, [0], "the slow original must be cancelled, not left running");
  });

  test("a first attempt that finally answers still wins over a slower hedge", async () => {
    const rec = recorder();

    const result = await runHedged({
      delayMs: DELAY,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return attempt === 0
          ? after(DELAY + 5, "original", signal)
          : after(10_000, "hedge", signal);
      },
    });

    assert.equal(result, "original");
    assert.deepEqual(rec.aborted, [1], "the hedge must be cancelled when the original lands");
  });

  test("a failure inside the window is the answer — a hedge is not a retry", async () => {
    const rec = recorder();
    const boom = new Error("provider 400");

    await assert.rejects(
      runHedged({
        delayMs: DELAY,
        run: ({ attempt, signal }) => {
          track(rec, attempt, signal);
          return Promise.reject(boom);
        },
      }),
      (err: unknown) => err === boom,
    );

    assert.deepEqual(rec.attempts, [0], "an early failure must not buy a second paid call");
  });

  test("a hedge rescues a first attempt that fails only after the window", async () => {
    const result = await runHedged({
      delayMs: DELAY,
      run: async ({ attempt, signal }) => {
        if (attempt === 1) return after(50, "hedge", signal);
        await after(DELAY + 5, null, signal);
        throw new Error("late failure");
      },
    });

    assert.equal(result, "hedge");
  });

  test("when both draws fail, the first attempt's error is what surfaces", async () => {
    const original = new Error("original failed");

    await assert.rejects(
      runHedged({
        delayMs: DELAY,
        run: async ({ attempt, signal }) => {
          if (attempt === 1) throw new Error("hedge failed");
          await after(DELAY + 5, null, signal);
          throw original;
        },
      }),
      (err: unknown) => err === original,
    );
  });

  test("delayMs 0 disables hedging entirely", async () => {
    const rec = recorder();

    const result = await runHedged({
      delayMs: 0,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return after(50, "only", signal);
      },
    });

    assert.equal(result, "only");
    assert.deepEqual(rec.attempts, [0]);
  });
});

/**
 * The budget is what stops the hedge from amplifying the condition it fires on.
 * A slow call is a per-call observation; a *burst* of slow calls is capacity
 * pressure, and duplicating every one of them doubles load into a provider that
 * is already 429ing. So the ceiling has to hold under exactly the case where
 * every call wants to hedge at once.
 */
describe("hedge budget", () => {
  test("a slow call past the ceiling runs un-hedged instead of failing", async () => {
    const budget = createHedgeBudget(0);
    const rec = recorder();

    const result = await runHedged({
      delayMs: DELAY,
      budget,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return after(DELAY + 5, "original", signal);
      },
    });

    assert.equal(result, "original", "exhausting the budget degrades to the un-hedged path");
    assert.deepEqual(rec.attempts, [0], "no duplicate draw once the ceiling is reached");
  });

  test("concurrent slow calls duplicate only up to the ceiling", async () => {
    const recs = Array.from({ length: 5 }, recorder);
    // NO duration decides this outcome. `delayMs` is the only timer left,
    // because wanting to hedge is what the case is about. See `ceilingHarness`.
    const gate = ceilingHarness(recs.length, createHedgeBudget(2));

    const results = await Promise.all(
      recs.map((rec) =>
        runHedged({
          delayMs: DELAY,
          budget: gate.budget,
          run: ({ attempt, signal }) => {
            track(rec, attempt, signal);
            // Every call is slow enough to want a hedge — the burst case. The
            // original answers only after the granted duplicates have, which is
            // what an over-budget call falls back to waiting for, and which makes
            // the hedge win its race by construction rather than by arithmetic
            // on two timeouts.
            if (attempt === 0) return gate.answered.then(() => "slow" as const);
            // A granted duplicate holds its slot until every caller has decided,
            // so it cannot hand a freed slot to a caller still making up its mind.
            return gate.decided.then(() => {
              gate.hedgeSettled();
              return "hedge" as const;
            });
          },
        }),
      ),
    );

    const hedged = recs.filter((rec) => rec.attempts.includes(1)).length;
    assert.equal(hedged, 2, "at most `ceiling` duplicates in flight across the whole process");
    assert.equal(
      results.filter((r) => r === "hedge").length,
      2,
      "the two budgeted calls got the fast draw",
    );
    assert.equal(
      results.filter((r) => r === "slow").length,
      3,
      "the rest still answered — over-budget means un-hedged, not failed",
    );
  });

  test("a slot is returned when its draw settles, not when the caller returns", async () => {
    const budget = createHedgeBudget(1);

    const first = await runHedged({
      delayMs: DELAY,
      budget,
      run: ({ attempt, signal }) =>
        attempt === 0 ? after(10_000, "slow", signal) : after(5, "hedge", signal),
    });
    assert.equal(first, "hedge");
    assert.equal(budget.inFlight(), 0, "the winning hedge released its slot on settle");

    // The next slow call is free to hedge again — a budget that leaked would
    // silently turn hedging off for the rest of the process's life.
    const rec = recorder();
    const second = await runHedged({
      delayMs: DELAY,
      budget,
      run: ({ attempt, signal }) => {
        track(rec, attempt, signal);
        return attempt === 0 ? after(10_000, "slow", signal) : after(5, "hedge", signal);
      },
    });
    assert.equal(second, "hedge");
    assert.deepEqual(rec.attempts, [0, 1]);
  });

  test("a cancelled loser also returns its slot", async () => {
    const budget = createHedgeBudget(1);

    // The original lands first, so the *hedge* is the one aborted — the slot
    // has to come back from that path too.
    const result = await runHedged({
      delayMs: DELAY,
      budget,
      run: ({ attempt, signal }) =>
        attempt === 0 ? after(DELAY + 5, "original", signal) : after(10_000, "hedge", signal),
    });

    assert.equal(result, "original");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(budget.inFlight(), 0);
  });

  test("the ceiling is a quarter of agent-worker concurrency, and never zero", () => {
    assert.equal(hedgeCeilingFor(8), 2, "the default: 8 primaries + 2 duplicates, not 16");
    assert.equal(hedgeCeilingFor(16), 4);
    // A single-concurrency process still gets to hedge its one call — the
    // pathology the budget prevents needs a burst, which it can't produce.
    assert.equal(hedgeCeilingFor(1), 1);
    assert.equal(hedgeCeilingFor(2), 1);
  });
});
