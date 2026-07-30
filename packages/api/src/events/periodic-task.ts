/**
 * A timer-driven background loop with a cooperative stop.
 *
 * The outbox relay and the outbox reaper both need the same five things, and
 * before this module each carried its own copy: a module-level `stopped` flag, a
 * re-entrancy guard so two passes never overlap, an unref'd interval so the
 * timer cannot hold the process open, a bounded drain on shutdown, and a
 * `catch` that keeps a failed pass from rejecting into the timer. The
 * duplication was structural rather than textual, so `pnpm dup` never saw it.
 *
 * The shared part is the lifecycle, not the trigger. The relay is
 * `LISTEN`-driven and owns its own pool; the reaper is purely periodic. So this
 * owns *when a pass may run* and nothing about what a pass does.
 *
 * **The stop is cooperative, which is the point.** `stop()` aborts the signal
 * handed to the pass and only then waits for it. A pass that loops has to check
 * `signal.aborted` between units of work, because the caller's next move after
 * `stop()` resolves is usually to tear down the connection pool the pass is
 * using. Hand-rolling this is what produced the bug this module replaces: the
 * reaper's `stopped` flag was never read between delete batches, so its
 * shutdown wait could return with a pass still mid-flight and the documented
 * protection did not exist.
 */
import { toMessage } from "@alfred/contracts";

export interface PeriodicTaskOptions {
  /** Log prefix, e.g. `"outbox-reaper"`. */
  name: string;
  /** How long after one pass ends before the next begins, absent a `trigger()`. */
  intervalMs: number;
  /**
   * Run one pass.
   *
   * A pass that does more than one unit of work must check `signal.aborted`
   * between units and return early. Rejections are logged, never rethrown.
   */
  pass: (signal: AbortSignal) => Promise<void>;
  /** Run a pass immediately on `start()`. Default `true`. */
  runOnStart?: boolean;
  /** How long `stop()` waits for an in-flight pass. Default 5s. */
  drainMs?: number;
}

const DEFAULT_DRAIN_MS = 5_000;
const DRAIN_POLL_MS = 50;

export class PeriodicTask {
  readonly #options: PeriodicTaskOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #controller = new AbortController();
  #stopped = true;
  #inFlight = false;
  /** A `trigger()` that arrived while a pass was running, coalesced to one re-run. */
  #pending = false;

  constructor(options: PeriodicTaskOptions) {
    this.#options = options;
    // Nothing runs until start(), so the initial signal is already aborted.
    // A caller that reads `signal` before start() must not see "live".
    this.#controller.abort();
  }

  /** True until `start()`, and again from the first line of `stop()`. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * Aborted for the whole time the task is not running. Callers with their own
   * side channels — the relay's `LISTEN` reconnect timer, for one — read this
   * instead of keeping a second `stopped` flag in sync by hand.
   */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Idempotent: a second call on a running task does nothing. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    // A fresh controller per run, because an AbortSignal cannot be un-aborted
    // and a restarted task must not hand its pass a dead signal.
    this.#controller = new AbortController();

    if (this.#options.runOnStart !== false) this.trigger();

    this.#timer = setInterval(
      () => {
        this.trigger();
      },
      this.#options.intervalMs,
    );
    // Never hold the process open for a maintenance loop.
    if (typeof this.#timer === "object" && "unref" in this.#timer) this.#timer.unref();
  }

  /**
   * Ask for a pass now.
   *
   * Coalescing, not queueing: any number of triggers during one pass schedule
   * exactly one more pass after it. This is what lets a burst of Postgres
   * `NOTIFY`s collapse into a single extra drain.
   */
  trigger(): void {
    if (this.#stopped) return;
    if (this.#inFlight) {
      this.#pending = true;
      return;
    }
    void this.#run();
  }

  async #run(): Promise<void> {
    this.#inFlight = true;
    try {
      do {
        this.#pending = false;
        try {
          await this.#options.pass(this.#controller.signal);
        } catch (err) {
          // A failed pass is not an outage — the next one retries. Swallowing
          // here is what keeps the rejection out of the timer callback.
          console.warn(`[${this.#options.name}] pass failed:`, toMessage(err));
        }
      } while (this.#pending && !this.#stopped);
    } finally {
      this.#inFlight = false;
    }
  }

  /**
   * Stop scheduling, abort the in-flight pass, and wait for it to notice.
   *
   * The wait is bounded so one stuck pass cannot block shutdown. It returns
   * `true` when the pass finished and `false` on timeout — a caller that is
   * about to close a pool the pass was using should log the difference rather
   * than assume the pass is done.
   */
  async stop(): Promise<boolean> {
    if (this.#stopped) return true;
    this.#stopped = true;
    this.#pending = false;

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    // Abort first, then wait: the order is what makes the wait likely to succeed.
    this.#controller.abort();

    const deadline = Date.now() + (this.#options.drainMs ?? DEFAULT_DRAIN_MS);
    while (this.#inFlight && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    if (this.#inFlight) {
      console.warn(`[${this.#options.name}] pass still running at shutdown deadline`);
      return false;
    }
    return true;
  }
}
