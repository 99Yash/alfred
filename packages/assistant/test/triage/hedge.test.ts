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
 * Hedged classify. A slow call gets a duplicate draw and the faster one wins.
 * A fast call never duplicates, the loser is cancelled, and a failure is not retried.
 */

const DELAY = 20;

/** Resolve after `ms`, or reject early if aborted. */
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

function track(rec: Recorder, attempt: HedgeAttempt, signal: AbortSignal): void {
  rec.attempts.push(attempt);
  signal.addEventListener("abort", () => rec.aborted.push(attempt));
}

interface CeilingHarness {
  budget: HedgeBudget;
  /** Resolves once every caller has decided whether to duplicate. */
  decided: Promise<void>;
  /** Resolves once every granted duplicate has answered. */
  answered: Promise<void>;
  /** Call from a hedge draw, just before it resolves. */
  hedgeSettled(): void;
}

/**
 * Sequence the ceiling case on `tryAcquire` counts, not durations.
 * On a loaded runner a hedge can free its slot mid-decision, so timers made this flaky.
 * `answered` waits for the granted count, so a grant-none bug fails instead of hanging.
 */
function ceilingHarness(callers: number, inner: HedgeBudget): CeilingHarness {
  // Promise executors run synchronously, so the openers exist before `tryAcquire` runs.
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

  // Wait for all decisions; before that, `granted` is still climbing.
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

/** A burst of slow calls is provider pressure; hedging all of them doubles load into a 429ing provider. */
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
    // No duration decides this outcome; see `ceilingHarness`.
    const gate = ceilingHarness(recs.length, createHedgeBudget(2));

    const results = await Promise.all(
      recs.map((rec) =>
        runHedged({
          delayMs: DELAY,
          budget: gate.budget,
          run: ({ attempt, signal }) => {
            track(rec, attempt, signal);

            // The original answers only after the granted duplicates, so the hedge always wins.
            if (attempt === 0) return gate.answered.then(() => "slow" as const);

            // Hold the slot until every caller has decided, so no late caller gets a freed slot.
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

    // A leaked slot would turn hedging off for the rest of the process.
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

    // The original lands first, so the hedge is the aborted one.
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
    // One worker cannot make a burst, so it may still hedge.
    assert.equal(hedgeCeilingFor(1), 1);
    assert.equal(hedgeCeilingFor(2), 1);
  });
});
