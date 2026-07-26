import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runHedged, type HedgeAttempt } from "../../src/modules/triage/hedge";

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
