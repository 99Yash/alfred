/**
 * A timer loop with a cooperative stop, shared by the outbox relay and reaper.
 * `stop()` aborts the pass's signal, then waits. A pass that loops must check
 * `signal.aborted` between units, because the caller usually closes the pool next.
 */
import { toMessage, unrefTimer } from "@alfred/contracts";

export interface PeriodicTaskOptions {
  name: string;
  /** Interval between scheduled triggers; a trigger during a pass is coalesced. */
  intervalMs: number;
  /** Check `signal.aborted` between units of work. Rejections are logged, never rethrown. */
  pass: (signal: AbortSignal) => Promise<void>;
  /** Default `true`. */
  runOnStart?: boolean;
  /** How long `stop()` waits for a pass. Default 5s. */
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
  /** Triggers during a pass coalesce to one re-run. */
  #pending = false;

  constructor(options: PeriodicTaskOptions) {
    this.#options = options;
    // Before start(), `signal` must read as aborted.
    this.#controller.abort();
  }

  /** True until `start()`, and again from the first line of `stop()`. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** Aborted whenever the task is not running. Read it instead of a second `stopped` flag. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Idempotent. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    // An AbortSignal cannot be un-aborted, so a restart needs a new controller.
    this.#controller = new AbortController();

    if (this.#options.runOnStart !== false) this.trigger();

    this.#timer = setInterval(
      () => {
        this.trigger();
      },
      this.#options.intervalMs,
    );

    unrefTimer(this.#timer);
  }

  /** Ask for a pass now. Any number of triggers during a pass run one more pass. */
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
          // The next pass retries. Do not reject into the timer.
          console.warn(`[${this.#options.name}] pass failed:`, toMessage(err));
        }
      } while (this.#pending && !this.#stopped);
    } finally {
      this.#inFlight = false;
    }
  }

  /** Abort the pass and wait, bounded. `false` means it was still running at the deadline. */
  async stop(): Promise<boolean> {
    if (this.#stopped) return true;
    this.#stopped = true;
    this.#pending = false;

    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

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
