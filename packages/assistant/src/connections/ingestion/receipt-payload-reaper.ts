/**
 * Retention for the `payload` of an `event_receipts` row. Release to NULL, never delete: the row
 * keeps the `(provider, provider_delivery_id)` dedup key, so an old redelivery stays a no-op, and
 * `history_id` for Gmail gap detection. The append-only trigger allows this one change (migration
 * 0139). TOAST chunks become reusable after autovacuum, so the table stops growing but does not
 * shrink. A released body reads as absent. `describeGithubReceipt` then shows a merged PR as
 * `PR #? updated`, and the github object-state backfill skips it. The full reader list is in the
 * 0139 migration header. Reads `eventReceipts`, not `typedEventReceipts`, so raw receipts expire
 * too.
 */
import { db } from "@alfred/db";
import { documents, eventReceipts } from "@alfred/db/schemas";
import { and, asc, eq, exists, isNotNull, lt, sql } from "drizzle-orm";
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { receiptDocumentJoin } from "./receipt-document";

/**
 * How long a receipt keeps its body. A chosen tradeoff: debug visibility and object-state rebuild
 * coverage against table size. The briefing watermark has no age bound, so no window fully protects
 * `gatherIntegrationActivity`. The release predicate, not this constant, protects the backfill and
 * redelivery readers.
 */
export const RECEIPT_PAYLOAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Rows released per statement. A chosen bound, not a derived one. The `EXISTS` makes the plan
 * depend on how far a page walks, and it flips between index and hash join on the same seed. Seeded
 * runs stayed near 0.02ms a row at this size. Re-measure with `EXPLAIN (ANALYZE, BUFFERS)` on
 * production data before you change it.
 */
const RELEASE_BATCH_SIZE = 1_000;

/** Statements per pass, so a first-run backlog spreads over passes. */
const MAX_BATCHES_PER_PASS = 20;

/** Overrides so a test can engage the paging bounds without seeding 20,001 rows. */
interface ReleaseOptions {
  /** Aborts the pass between batches. */
  signal?: AbortSignal;
  /** Rows per statement. Defaults to `RELEASE_BATCH_SIZE`. */
  batchSize?: number;
  /** Statements per pass. Defaults to `MAX_BATCHES_PER_PASS`. */
  maxBatches?: number;
}

/** Hourly. The table's problem is unbounded growth, not latency. */
const RELEASE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Release one bounded page of expired bodies. Each clause has a reason:
 * - `payload IS NOT NULL`: matches the partial index `event_receipts_payload_live_idx`.
 * - `delivered_at < cutoff`: the expiry.
 * - `processing_status = 'completed'`, not `<> 'failed'`: a `pending` or `failed` receipt can still
 *   be retried, and the object-state fold reads `payload` later.
 * - `EXISTS` corpus document: `receipt-corpus-backfill.ts` projects from the body. A released
 *   receipt gives a hollow document that the backfill then never fixes. `= any(array(...))`, not
 *   `in (...)`: `in` plans a full-table Hash Semi Join; `array()` gives a primary-key `Index Cond`
 *   (91ms vs 2.5ms on 800k rows). `markProcessed` has no status guard, so `completed` can still
 *   change to `failed` mid-pass.
 */
async function releaseBatch(cutoff: Date, batchSize: number): Promise<number> {
  const page = db()
    .select({ id: eventReceipts.id })
    .from(eventReceipts)
    .where(
      and(
        isNotNull(eventReceipts.payload),
        lt(eventReceipts.deliveredAt, cutoff),
        eq(eventReceipts.processingStatus, "completed"),
        exists(db().select({ id: documents.id }).from(documents).where(receiptDocumentJoin())),
      ),
    )
    // `delivered_at`, not `id`: `evr` ids are random nanoids. Oldest-first matches the partial
    // index and the corpus backfill drain order.
    .orderBy(asc(eventReceipts.deliveredAt))
    .limit(batchSize);

  const released = await db()
    .update(eventReceipts)
    // `.set({ payload: null })` binds SQL NULL. A placeholder binds JSON `null`, which the 0139
    // write-once trigger reads as a replacement body and rejects.
    .set({ payload: null })
    // Repeat the two mutable clauses in the outer WHERE. The page is an InitPlan from this
    // statement's snapshot, and EvalPlanQual re-checks only the outer clauses after a lock wait.
    // - `payload IS NOT NULL`: else a second process re-releases the winner's rows and counts them
    //   twice.
    // - `processing_status`: else a receipt marked `failed` during the wait still loses its body.
    .where(
      and(
        sql`${eventReceipts.id} = any(array(${page}))`,
        isNotNull(eventReceipts.payload),
        eq(eventReceipts.processingStatus, "completed"),
      ),
    )
    .returning({ id: eventReceipts.id });

  return released.length;
}

/** In-process guard only. The outer `WHERE` clauses protect against a second process. */
let passInFlight = false;

/**
 * Run one retention pass and return the number of bodies released. `now` is required, not optional:
 * this cutoff decides what data is destroyed. A caller that arrives during a pass gets `0`.
 * `signal` stops the pass between batches, so `PeriodicTask.stop()` can drain in time.
 */
export async function releaseExpiredReceiptPayloadsOnce(
  now: Date,
  options: ReleaseOptions = {},
): Promise<number> {
  if (passInFlight) return 0;
  passInFlight = true;

  try {
    const { signal, batchSize = RELEASE_BATCH_SIZE } = options;
    const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_PASS;
    const cutoff = new Date(now.getTime() - RECEIPT_PAYLOAD_RETENTION_MS);
    let total = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Check between batches: one batch is one `UPDATE`, so it either committed or did not.
      if (signal?.aborted) break;
      const released = await releaseBatch(cutoff, batchSize);
      total += released;

      if (released < batchSize) break;
    }

    return total;
  } finally {
    passInFlight = false;
  }
}

const reaper = new PeriodicTask({
  name: "receipt-payload-reaper",
  intervalMs: RELEASE_INTERVAL_MS,
  // Run at boot too, so a process that restarts often still releases.
  runOnStart: true,
  pass: async (signal) => {
    const released = await releaseExpiredReceiptPayloadsOnce(new Date(), { signal });

    if (released > 0) console.info("[receipt-payload-reaper] released", released, "expired bodies");
  },
});

export function startReceiptPayloadReaper(): void {
  if (!reaper.stopped) return;
  reaper.start();
  console.info("[receipt-payload-reaper] started");
}

export async function stopReceiptPayloadReaper(): Promise<void> {
  await reaper.stop();
}
