import { toMessage } from "@alfred/contracts";
import { isChatStopRequested } from "../../chat/stop-signal";

/** Poll the user-stop flag at most this often (ms). */
const STOP_CHECK_MS = 400;

/**
 * Owns a chat turn's user-stop lifecycle: a single {@link AbortController} whose
 * signal covers the foreground context guard (compaction can make billable model
 * calls too) and the streamed answer, plus a throttled poll of the Redis stop
 * flag. Extracted from `chat-turn`'s step body so the stop machinery is testable
 * in isolation (`vi.useFakeTimers` + an injected `isStopRequested`) and the step
 * body reads as orchestration. The dispatch-tools step keeps its own one-shot
 * `isChatStopRequested` check — a single up-front read, not worth wrapping.
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
}

export function createTurnStopController(
  runId: string,
  opts?: { isStopRequested?: (runId: string) => Promise<boolean> },
): TurnStopController {
  const isStopRequested = opts?.isStopRequested ?? isChatStopRequested;
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

  return {
    signal: controller.signal,
    get stopped() {
      return stopRequested;
    },
    checkStop,
    startPolling,
  };
}
