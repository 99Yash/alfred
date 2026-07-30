import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PeriodicTask } from "../../src/events/periodic-task";

/**
 * The lifecycle both outbox loops run on.
 *
 * These need no database, which is the point of the extraction: the property
 * that was broken — a `stop()` that returns while a pass is still working — is a
 * property of the scheduler, not of any SQL. Before this module the reaper's
 * copy of the loop never read its stop flag between batches, so its documented
 * "shutdown does not tear the pool out from under an open DELETE" was false and
 * nothing could observe that.
 */

/** Yield to the macrotask queue so a pending pass gets to run. */
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PeriodicTask", () => {
  test("runs a pass on start by default, and not when runOnStart is false", async () => {
    let eager = 0;
    let lazy = 0;

    const eagerTask = new PeriodicTask({
      name: "eager",
      intervalMs: 60_000,
      pass: async () => {
        eager += 1;
      },
    });
    const lazyTask = new PeriodicTask({
      name: "lazy",
      intervalMs: 60_000,
      runOnStart: false,
      pass: async () => {
        lazy += 1;
      },
    });

    eagerTask.start();
    lazyTask.start();
    await tick();

    assert.equal(eager, 1, "the default must reap at boot — a process restarting often still runs");
    assert.equal(lazy, 0, "runOnStart:false must wait for a trigger");

    // Only the trigger separates the two tasks, so this proves the flag gates
    // the boot pass rather than the pass itself.
    lazyTask.trigger();
    await tick();
    assert.equal(lazy, 1);

    await eagerTask.stop();
    await lazyTask.stop();
  });

  test("stop aborts the in-flight pass and waits for it to return", async () => {
    let observedAbort = false;
    let finished = false;

    const task = new PeriodicTask({
      name: "cooperative",
      intervalMs: 60_000,
      pass: async (signal) => {
        // Stands in for "another delete batch": loop until asked to stop. The
        // iteration cap is not decoration — without it a task that never aborts
        // spins forever and the mutant wedges the suite instead of failing it.
        for (let i = 0; i < 200 && !signal.aborted; i += 1) await tick(1);
        observedAbort = signal.aborted;
        await tick(1);
        finished = true;
      },
    });

    task.start();
    await tick();
    assert.equal(finished, false, "the pass must still be running, or this proves nothing");

    const drained = await task.stop();

    assert.equal(observedAbort, true, "the pass must see its signal abort");
    assert.equal(
      finished,
      true,
      "stop() must not resolve until the pass returned — a caller closes the pool next",
    );
    assert.equal(drained, true, "a pass that cooperates reports a clean drain");
  });

  test("stop reports false when the pass ignores its signal", async () => {
    let released = () => {};
    const blocked = new Promise<void>((resolve) => {
      released = resolve;
    });

    const task = new PeriodicTask({
      name: "stubborn",
      intervalMs: 60_000,
      drainMs: 60,
      // Deliberately never reads `signal` — the shape of the bug this replaces.
      pass: async () => {
        await blocked;
      },
    });

    task.start();
    await tick();
    const drained = await task.stop();

    assert.equal(
      drained,
      false,
      "a timed-out drain must be reported, not swallowed — the caller is about to close the pool",
    );
    released();
    await tick();
  });

  test("triggers during a pass coalesce into exactly one more pass", async () => {
    let passes = 0;
    let release = () => {};
    const firstPass = new Promise<void>((resolve) => {
      release = resolve;
    });

    const task = new PeriodicTask({
      name: "coalescing",
      intervalMs: 60_000,
      runOnStart: false,
      pass: async () => {
        passes += 1;
        if (passes === 1) await firstPass;
      },
    });

    task.start();
    task.trigger();
    await tick();
    assert.equal(passes, 1, "the first trigger starts a pass");

    // A burst of NOTIFYs while that pass is busy.
    task.trigger();
    task.trigger();
    task.trigger();
    release();
    await tick();

    assert.equal(passes, 2, "three overlapping triggers must queue one re-run, not three");

    await task.stop();
  });

  test("a rejected pass is logged, not rethrown, and the loop survives it", async () => {
    let passes = 0;
    const warnings: unknown[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args[0]);
    };

    const task = new PeriodicTask({
      name: "failing",
      intervalMs: 60_000,
      pass: async () => {
        passes += 1;
        throw new Error("pass exploded");
      },
    });

    try {
      task.start();
      await tick();
      task.trigger();
      await tick();
    } finally {
      console.warn = realWarn;
    }

    assert.equal(passes, 2, "a failed pass must not stop later passes");
    assert.ok(
      warnings.some((w) => typeof w === "string" && w.includes("[failing] pass failed:")),
      "the failure must be visible",
    );

    await task.stop();
  });

  test("start and stop are idempotent, and a restarted task gets a live signal", async () => {
    let passes = 0;
    let sawLiveSignal = false;

    const task = new PeriodicTask({
      name: "restartable",
      intervalMs: 60_000,
      pass: async (signal) => {
        passes += 1;
        if (!signal.aborted) sawLiveSignal = true;
      },
    });

    assert.equal(task.stopped, true, "a fresh task is stopped");
    assert.equal(task.signal.aborted, true, "and its signal reads aborted, never 'live'");

    task.start();
    task.start();
    await tick();
    assert.equal(passes, 1, "a second start must not add a second boot pass");
    assert.equal(task.stopped, false);

    assert.equal(await task.stop(), true);
    assert.equal(await task.stop(), true, "a second stop is a no-op");
    assert.equal(task.signal.aborted, true);

    // An AbortSignal cannot be un-aborted, so a restart must mint a new one.
    sawLiveSignal = false;
    task.start();
    await tick();
    assert.equal(passes, 2);
    assert.equal(sawLiveSignal, true, "a restarted task must not hand its pass a dead signal");

    await task.stop();
  });

  test("a trigger after stop does nothing", async () => {
    let passes = 0;
    const task = new PeriodicTask({
      name: "quiet",
      intervalMs: 60_000,
      runOnStart: false,
      pass: async () => {
        passes += 1;
      },
    });

    task.start();
    await task.stop();
    task.trigger();
    await tick();

    assert.equal(passes, 0, "a late NOTIFY must not start work against a closing pool");
  });
});
