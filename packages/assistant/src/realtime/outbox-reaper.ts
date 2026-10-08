/**
 * Retention for `events_outbox` (#533), the highest-volume table.
 * Only published rows are reaped: an unpublished row is undelivered work, at any age.
 * Deletes are batched and go through the primary key (see `reapBatch`).
 * No `SKIP LOCKED` and no own pool: two racing reapers are harmless, and each delete is a few ms.
 */
import { db } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { and, isNotNull, lt, sql } from "drizzle-orm";
import { PeriodicTask } from "./periodic-task";

/**
 * A chosen tradeoff, not a safe bound: the web replay cursor never expires
 * (`apps/web/src/lib/events/replay-anchor.ts`). A cursor older than this gets
 * a silent gap; #532 tracks detection.
 */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows deleted per statement. */
export const REAP_BATCH_SIZE = 5_000;

/** Statements per pass; a large backlog spreads over passes. */
export const MAX_BATCHES_PER_PASS = 20;

/** Lower bounds let a test page without seeding 100,001 rows. */
export interface ReapOptions {
  signal?: AbortSignal;
  batchSize?: number;
  maxBatches?: number;
}

/** Hourly: the problem is growth, not latency. */
const REAP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete one page of expired published rows.
 * Use `= any(array(...))`, not `in (...)`: `in` seq-scans the whole table (91ms
 * vs 2.5ms at 800k rows). Re-run `EXPLAIN (ANALYZE, BUFFERS)` before a change.
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

let passInFlight = false;

/**
 * Run one pass and return the rows deleted. A call during a pass returns `0`;
 * the guard is here because direct callers bypass the scheduler.
 * `now` is positional because an all-optional options bag would accept a bare `Date`.
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
      // Check between batches, so shutdown never abandons an open DELETE.
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
  // A process that restarts more often than hourly still reaps.
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

/** For tests. */
export function isOutboxReaperRunning(): boolean {
  return !reaper.stopped;
}
