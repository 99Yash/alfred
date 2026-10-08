import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";

import { createTurnStopController } from "@alfred/assistant/chat/turn-stop-controller";

/**
 * The stop flag is read at most once per `STOP_CHECK_MS` (400ms), and concurrent
 * checks share one read. A stop aborts the signal once and latches.
 */
describe("createTurnStopController", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  test("throttles backing reads to at most one per STOP_CHECK_MS", async () => {
    mock.timers.enable({ apis: ["Date"] });
    let calls = 0;

    const stop = createTurnStopController("run-1", {
      isStopRequested: async () => {
        calls += 1;

        return false;
      },
    });

    // Construction stamps `lastStopCheck`, so the first window is throttled too.
    assert.equal(await stop.checkStop(), false);
    assert.equal(calls, 0);

    mock.timers.tick(400);
    assert.equal(await stop.checkStop(), false);
    assert.equal(calls, 1);

    assert.equal(await stop.checkStop(), false);
    assert.equal(calls, 1);

    mock.timers.tick(400);
    assert.equal(await stop.checkStop(), false);
    assert.equal(calls, 2);
  });

  test("observing a stop aborts the signal once and latches `stopped`", async () => {
    mock.timers.enable({ apis: ["Date"] });
    let calls = 0;

    const stop = createTurnStopController("run-2", {
      isStopRequested: async () => {
        calls += 1;

        return true;
      },
    });

    assert.equal(stop.stopped, false);
    assert.equal(stop.signal.aborted, false);

    mock.timers.tick(400);
    assert.equal(await stop.checkStop(), true);
    assert.equal(stop.stopped, true);
    assert.equal(stop.signal.aborted, true);
    assert.equal(calls, 1);

    // Once stopped, checks return true without a read, even in a fresh window.
    mock.timers.tick(400);
    assert.equal(await stop.checkStop(), true);
    assert.equal(calls, 1);
  });

  test("de-dupes an in-flight read across a burst of checks", async () => {
    mock.timers.enable({ apis: ["Date"] });
    let calls = 0;
    let resolvePending: ((value: boolean) => void) | undefined;

    const stop = createTurnStopController("run-3", {
      isStopRequested: () => {
        calls += 1;

        return new Promise<boolean>((resolve) => {
          resolvePending = resolve;
        });
      },
    });

    mock.timers.tick(400);
    const first = stop.checkStop();
    assert.equal(calls, 1);

    // Past the window but with the first read pending: reuse it.
    mock.timers.tick(400);
    const second = stop.checkStop();
    assert.equal(calls, 1);

    resolvePending?.(false);
    assert.equal(await first, false);
    assert.equal(await second, false);
  });

  test("startPolling drives checks on an interval and its disposer stops them", async () => {
    mock.timers.enable({ apis: ["setInterval", "Date"] });
    let calls = 0;

    const stop = createTurnStopController("run-4", {
      isStopRequested: async () => {
        calls += 1;

        return false;
      },
    });

    // Clear `stopCheckInFlight` before the next tick, or the de-dupe swallows the next read.
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    };

    const dispose = stop.startPolling();
    mock.timers.tick(400);
    await settle();
    assert.equal(calls, 1);
    mock.timers.tick(400);
    await settle();
    assert.equal(calls, 2);

    dispose();
    mock.timers.tick(400);
    mock.timers.tick(400);
    await settle();
    assert.equal(calls, 2, "no further reads fire after the disposer runs");
  });

  test("defaults to a live signal that is not pre-aborted", () => {
    const stop = createTurnStopController("run-5", { isStopRequested: async () => false });
    assert.equal(stop.stopped, false);
    assert.equal(stop.signal.aborted, false);
  });
});
