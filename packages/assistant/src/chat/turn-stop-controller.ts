import { toMessage } from "@alfred/contracts";
import { pollChatStopFlag } from "./stop-signal";

/** Poll the user-stop flag at most this often (ms). */
const STOP_CHECK_MS = 400;

/** One abort signal for a turn's context guard and stream, driven by a throttled poll of the stop flag. */
export interface TurnStopController {
  /** The abort signal to pass to the context guard and `streamTurn`. */
  readonly signal: AbortSignal;
  readonly stopped: boolean;
  /** Throttled poll. Aborts {@link signal} on the first stop seen. */
  checkStop(): Promise<boolean>;
  /** Poll on an interval, for code with no stream loop. Returns a disposer. */
  startPolling(): () => void;
  /**
   * Sleep `ms`, or end early on Stop. Polls while it waits: {@link signal} fires
   * only from {@link checkStop}, so a wait on the bare signal never ends early.
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
