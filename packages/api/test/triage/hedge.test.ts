import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createHedgeBudget,
  hedgeCeilingFor,
  runHedged,
  type HedgeAttempt,
} from "../../src/modules/triage/hedge";

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
    const budget = createHedgeBudget(2);
    const recs = Array.from({ length: 5 }, recorder);

    const results = await Promise.all(
      recs.map((rec) =>
        runHedged({
          delayMs: DELAY,
          budget,
          run: ({ attempt, signal }) => {
            track(rec, attempt, signal);
            // Every call is slow enough to want a hedge — the burst case. The
            // original still answers eventually, which is what an over-budget
            // call falls back to waiting for.
            return attempt === 0 ? after(DELAY * 3, "slow", signal) : after(1, "hedge", signal);
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
