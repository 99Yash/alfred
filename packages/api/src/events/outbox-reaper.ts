/**
 * Retention for `events_outbox` (#533).
 *
 * Every realtime frame — each `chat.delta`, each `chat.reasoning`, each
 * `agent.run` phase — is one permanent row today. The relay stamps
 * `published_at` on drain and nothing ever deletes, so the highest-volume table
 * in the system grows without bound, the unpublished partial index gets more
 * expensive to maintain, and `MAX(id)` replay scans degrade.
 *
 * Two rules make this safe to run unattended:
 *
 *   1. **Only published rows are reaped.** A row with `published_at IS NULL` is
 *      undelivered work. If the relay is broken or a publish is retrying, its
 *      rows must survive however long that takes, so the predicate excludes
 *      them regardless of age.
 *   2. **Deletes are batched, bounded, and index-driven.** One unbounded
 *      `DELETE` over a table this size holds locks for as long as it takes. Each
 *      statement takes a bounded id page, each pass stops after a fixed number
 *      of pages, and the statement reaches its rows through the primary key
 *      rather than a scan — see `reapBatch` for why that last part needs care.
 *
 * Deleting rows does not disturb the id sequence, so replay ids stay monotonic
 * and no consumer sees an id reused.
 *
 * Two deliberate omissions, both free at one replica and both cheap to add if
 * that changes:
 *
 *   - **No `FOR UPDATE SKIP LOCKED`**, unlike the sibling relay. The relay needs
 *     it because two drains racing the same row would publish it twice. Two
 *     reapers racing the same id page are harmless: the loser's `DELETE` matches
 *     nothing and the pass just reports fewer rows. Add it with the second
 *     replica, for symmetry rather than correctness.
 *   - **No dedicated pool.** The relay builds its own `pg.Pool` because it holds
 *     a transaction open across a Redis publish for every batch. The reaper
 *     issues at most `MAX_BATCHES_PER_PASS` statements an hour, each a
 *     single-digit-millisecond indexed delete, so it borrows the shared `db()`
 *     pool that #437 sized. This is only true while the delete stays
 *     index-driven; the pre-fix scanning form cost ~91ms a statement and would
 *     have deserved its own pool.
 */
import { db } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import { PeriodicTask } from "./periodic-task";

/**
 * How long a published row stays replayable.
 *
 * #533 suggested "hours, not days", reasoning from a client's disconnect
 * window. No constant can be derived that way, and it is worth being plain
 * about why: the web app persists its replay cursor in `localStorage` with no
 * expiry (`apps/web/src/lib/events/replay-anchor.ts`), so a cursor can be
 * arbitrarily old and *no* finite window is guaranteed to contain it. Seven days
 * is not "safe" where 24 hours is "unsafe" — it is 7x the rows on the table this
 * module exists to bound, buying a wider best-effort window.
 *
 * So this is a tradeoff, chosen and not deduced: keep enough history that an
 * ordinary reconnect — a laptop shut for a long weekend — replays cleanly, while
 * still bounding growth. It is deliberately generous because the failure it
 * trades against is currently silent.
 *
 * That silence is the real defect, and a constant cannot fix it. A cursor below
 * the window points into reaped history and the client receives nothing for the
 * gap instead of being told it has one. #532 tracks the detection, which is what
 * actually closes this question; the reaper already knows the highest id it
 * deleted, so it is cheap. Revisit this number then, not before.
 */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows deleted per statement. */
export const REAP_BATCH_SIZE = 5_000;

/** Statements per pass, so a large backlog spreads over passes. */
export const MAX_BATCHES_PER_PASS = 20;

/**
 * A pass with both bounds lowered, so a test can engage them without seeding
 * `REAP_BATCH_SIZE * MAX_BATCHES_PER_PASS` rows.
 *
 * The bounds are parameters for the same reason `now` is: at their production
 * values the paging behavior needs 100,001 rows to become observable, so it
 * would go untested and a mutant that removed either bound would survive. The
 * defaults are the contract; the parameters only make it cheap to watch.
 */
export interface ReapOptions {
  /** Aborts the pass between batches. */
  signal?: AbortSignal;
  /** Rows per statement. Defaults to `REAP_BATCH_SIZE`. */
  batchSize?: number;
  /** Statements per pass. Defaults to `MAX_BATCHES_PER_PASS`. */
  maxBatches?: number;
}

/** Hourly. The table's problem is unbounded growth, not latency. */
const REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete one bounded page of expired published rows.
 *
 * The id page is selected in a subquery so the `DELETE` targets a fixed set
 * rather than re-evaluating the predicate against rows the relay is writing
 * concurrently.
 *
 * **`= any(array(...))`, not `in (...)`.** The two look interchangeable and are
 * not. With `id in (subquery)` Postgres plans a Hash Semi Join and reads *every
 * row in the table* to find the page: measured on an 800k-row copy, 91ms and
 * 12,540 buffer hits per statement, growing with the table, 20 times an hour.
 * Wrapping the subquery in `array()` makes it an InitPlan whose result feeds an
 * `Index Cond` on the primary key: 2.5ms and 5,126 buffers on the same table.
 * The bound on rows deleted was never the problem — the bound on rows *examined*
 * was missing. Re-plan with `EXPLAIN (ANALYZE, BUFFERS)` before touching this.
 */
async function reapBatch(cutoff: Date, batchSize: number): Promise<number> {
  const expired = db()
    .select({ id: eventsOutbox.id })
    .from(eventsOutbox)
    .where(and(isNotNull(eventsOutbox.publishedAt), lt(eventsOutbox.publishedAt, cutoff)))
    .orderBy(eventsOutbox.id)
    .limit(batchSize);

  const deleted = await db()
    .delete(eventsOutbox)
    .where(sql`${eventsOutbox.id} = any(array(${expired}))`)
    .returning({ id: eventsOutbox.id });

  return deleted.length;
}

/** Serializes the exported pass against the scheduled one. See `reapOutboxOnce`. */
let passInFlight = false;

/**
 * Run one retention pass. Returns the number of rows deleted.
 *
 * Two passes must not overlap. They would select the same id page, and the
 * loser's `DELETE` would match nothing while both held pool connections. The
 * scheduler's own re-entrancy guard is not enough, because this function is
 * exported: a script or a future admin route calling it directly would run
 * alongside the hourly timer. So the guard lives here, on the entrypoint, and a
 * caller who arrives during a pass gets `0` rather than a redundant scan.
 *
 * `signal` is what makes the pass interruptible — without a check between
 * batches, a shutdown would abandon a pass mid-flight and the pool could close
 * under an open `DELETE`.
 *
 * `now` stays a positional parameter rather than joining the options object, and
 * that is deliberate: every property of `ReapOptions` is optional, so a stray
 * `reapOutboxOnce(someDate)` would type-check as an options bag with no `now`,
 * silently reap against the real clock, and pass. Nothing would catch it — this
 * package's `tsc` covers `src` only, so test files are unchecked.
 */
export async function reapOutboxOnce(
  now: Date = new Date(),
  options: ReapOptions = {},
): Promise<number> {
  if (passInFlight) return 0;
  passInFlight = true;
  try {
    const { signal, batchSize = REAP_BATCH_SIZE } = options;
    const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_PASS;
    const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_MS);
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Between batches, never inside one: a half-deleted page is fine (the
      // next pass finds the rest) but an abandoned open DELETE is not.
      if (signal?.aborted) break;
      const deleted = await reapBatch(cutoff, batchSize);
      total += deleted;
      if (deleted < batchSize) break;
    }
    return total;
  } finally {
    passInFlight = false;
  }
}

const reaper = new PeriodicTask({
  name: "outbox-reaper",
  intervalMs: REAP_INTERVAL_MS,
  // One pass at boot, so a process that restarts more often than the interval
  // still reaps.
  runOnStart: true,
  pass: async (signal) => {
    const deleted = await reapOutboxOnce(new Date(), { signal });
    if (deleted > 0) console.info("[outbox-reaper] deleted", deleted, "expired rows");
  },
});

export function startOutboxReaper(): void {
  if (!reaper.stopped) return;
  reaper.start();
  console.info("[outbox-reaper] started");
}

export async function stopOutboxReaper(): Promise<void> {
  await reaper.stop();
}

/** Exported for tests that need to observe the scheduler rather than one pass. */
export function isOutboxReaperRunning(): boolean {
  return !reaper.stopped;
}
