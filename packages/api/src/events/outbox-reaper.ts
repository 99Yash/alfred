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
 *   2. **Deletes are batched and bounded.** One unbounded `DELETE` over a table
 *      this size holds locks for as long as it takes. Each statement takes a
 *      bounded id page, and each pass stops after a fixed number of pages so a
 *      long backlog is drained over several passes instead of one long
 *      transaction.
 *
 * Deleting rows does not disturb the id sequence, so replay ids stay monotonic
 * and no consumer sees an id reused.
 */
import { db } from "@alfred/db";
import { eventsOutbox } from "@alfred/db/schemas";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { toMessage } from "@alfred/contracts";

/**
 * How long a published row stays replayable.
 *
 * #533 suggested "hours, not days", reasoning from a client's disconnect
 * window. That is too short for the client this server actually has: the web
 * app persists its replay cursor in `localStorage` with no expiry
 * (`apps/web/src/lib/events/replay-anchor.ts`), so a tab left open over a
 * weekend, or one holding the stale barrier that `replay-state.ts` documents,
 * reconnects with a cursor that old and asks for a replay from it.
 *
 * Seven days keeps growth bounded — the point of the reaper — while leaving
 * every plausible cursor inside the window. A cursor older than this points
 * into reaped history and the client silently receives nothing for the gap;
 * that detection is the missing half, tracked with #532 rather than guessed at
 * here.
 */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows deleted per statement. */
const REAP_BATCH_SIZE = 5_000;

/** Statements per pass, so a large backlog spreads over passes. */
const MAX_BATCHES_PER_PASS = 20;

/** Hourly. The table's problem is unbounded growth, not latency. */
const REAP_INTERVAL_MS = 60 * 60 * 1000;

let reapTimer: ReturnType<typeof setInterval> | undefined;
let stopped = true;
let reapInFlight = false;

/**
 * Delete one bounded page of expired published rows.
 *
 * The id page is selected in a subquery so the `DELETE` targets a fixed set
 * rather than re-evaluating the predicate against rows the relay is writing
 * concurrently.
 */
async function reapBatch(cutoff: Date): Promise<number> {
  const expired = db()
    .select({ id: eventsOutbox.id })
    .from(eventsOutbox)
    .where(and(isNotNull(eventsOutbox.publishedAt), lt(eventsOutbox.publishedAt, cutoff)))
    .orderBy(eventsOutbox.id)
    .limit(REAP_BATCH_SIZE);

  const deleted = await db()
    .delete(eventsOutbox)
    .where(inArray(eventsOutbox.id, expired))
    .returning({ id: eventsOutbox.id });

  return deleted.length;
}

/**
 * Run one retention pass. Returns the number of rows deleted.
 *
 * `now` is injectable so a test can age rows without waiting; production always
 * uses the default.
 */
export async function reapOutboxOnce(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_MS);
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    const deleted = await reapBatch(cutoff);
    total += deleted;
    if (deleted < REAP_BATCH_SIZE) break;
  }
  return total;
}

async function reapLoop(): Promise<void> {
  if (reapInFlight || stopped) return;
  reapInFlight = true;
  try {
    const deleted = await reapOutboxOnce();
    if (deleted > 0) console.info("[outbox-reaper] deleted", deleted, "expired rows");
  } catch (err) {
    // A failed pass is not an outage: the rows are still there and the next
    // pass retries. Never let it reject into the timer.
    console.warn("[outbox-reaper] pass failed:", toMessage(err));
  } finally {
    reapInFlight = false;
  }
}

export function startOutboxReaper(): void {
  if (!stopped) return;
  stopped = false;

  // One pass at boot, so a process that restarts more often than the interval
  // still reaps. Not awaited — boot must not wait on a maintenance sweep.
  void reapLoop();

  reapTimer = setInterval(() => {
    void reapLoop();
  }, REAP_INTERVAL_MS);
  if (typeof reapTimer === "object" && "unref" in reapTimer) {
    reapTimer.unref();
  }

  console.info("[outbox-reaper] started");
}

export async function stopOutboxReaper(): Promise<void> {
  if (stopped) return;
  stopped = true;

  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = undefined;
  }

  // Let an in-flight pass finish so shutdown does not tear the pool out from
  // under an open DELETE. Bounded, so a stuck pass cannot block shutdown.
  const deadline = Date.now() + 5_000;
  while (reapInFlight && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
