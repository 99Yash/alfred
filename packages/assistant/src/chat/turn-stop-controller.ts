import { toMessage } from "@alfred/contracts";
import { pollChatStopFlag } from "./stop-signal";

/** Poll the user-stop flag at most this often (ms). */
const STOP_CHECK_MS = 400;

/**
 * Owns a chat turn's user-stop lifecycle: a single {@link AbortController} whose
 * signal covers the foreground context guard (compaction can make billable model
 * calls too) and the streamed answer, plus a throttled poll of the Redis stop
 * flag. Extracted from `chat-turn`'s step body so the stop machinery is testable
 * in isolation (`vi.useFakeTimers` + an injected `isStopRequested`) and the step
 * body reads as orchestration. The dispatch-tools step keeps its own one-shot
 * check — a single up-front read, not worth wrapping — and that read goes
 * through `isChatStopRequested`, not through the `pollChatStopFlag` below,
 * because a one-shot reader cannot afford a rejected cold read (#127).
 */
export interface TurnStopController {
  /** The abort signal to pass to the context guard and `streamTurn`. */
  readonly signal: AbortSignal;
  /** Live view of whether a stop has been observed (read by the post-drain branches). */
  readonly stopped: boolean;
  /**
   * Throttled poll of the stop flag ({@link STOP_CHECK_MS}). Returns `true` once a
   * stop is observed and, on first observation, aborts {@link signal}. In-flight
   * reads are de-duped so a burst of calls issues at most one Redis read.
   */
  checkStop(): Promise<boolean>;
  /**
   * Start a background interval that drives {@link checkStop} while the context
   * guard runs (the guard has no stream loop to poll from). Returns a disposer;
   * call it in a `finally`.
   */
  startPolling(): () => void;
  /**
   * Sleep `ms`, and end early the moment a user stop lands.
   *
   * This exists so a caller cannot wait on {@link signal} alone. The stop flag
   * lives in Redis, and `controller.abort()` fires only from inside
   * {@link checkStop} — so a signal with no poller behind it can never fire,
   * however long the wait. The capacity backoff learned that the expensive
   * way: it slept on the signal after the guard's poller was already disposed,
   * and a user Stop went unheard for the whole backoff and then billed a full
   * model turn. Polling for the duration of the wait is therefore part of the
   * wait, not something the caller may forget to arrange.
   *
   * Returns the ending, rather than resolving void or rejecting, so the caller
   * must name both cases: a stopped turn and an elapsed backoff want opposite
   * endings, and a rejection would have made "stopped" look like a fault.
   */
  wait(ms: number): Promise<"elapsed" | "stopped">;
}

export function createTurnStopController(
  runId: string,
  opts?: { isStopRequested?: (runId: string) => Promise<boolean> },
): TurnStopController {
  const isStopRequested = opts?.isStopRequested ?? pollChatStopFlag;
  const controller = new AbortController();
  let stopRequested = false;
  let lastStopCheck = Date.now();
  let stopCheckInFlight: Promise<boolean> | undefined;

  const checkStop = (): Promise<boolean> => {
    if (stopRequested) return Promise.resolve(true);

    if (Date.now() - lastStopCheck < STOP_CHECK_MS) return Promise.resolve(false);

    if (stopCheckInFlight) return stopCheckInFlight;
    lastStopCheck = Date.now();
    stopCheckInFlight = isStopRequested(runId)
      .then((requested) => {
        if (requested) {
          stopRequested = true;
          controller.abort();
        }

        return stopRequested;
      })
      .finally(() => {
        stopCheckInFlight = undefined;
      });

    return stopCheckInFlight;
  };

  const startPolling = (): (() => void) => {
    const handle = setInterval(() => {
      void checkStop().catch((error: unknown) => {
        console.warn(`[chat-turn] stop polling failed (run ${runId}):`, toMessage(error));
      });
    }, STOP_CHECK_MS);

    return () => clearInterval(handle);
  };

  const wait = async (ms: number): Promise<"elapsed" | "stopped"> => {
    if (stopRequested) return "stopped";

    const disposePolling = startPolling();

    try {
      return await new Promise<"elapsed" | "stopped">((resolve) => {
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve("elapsed");
        }, ms);

        function onAbort() {
          clearTimeout(timer);
          resolve("stopped");
        }

        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      disposePolling();
    }
  };

  return {
    signal: controller.signal,
    get stopped() {
      return stopRequested;
    },
    checkStop,
    startPolling,
    wait,
  };
}
