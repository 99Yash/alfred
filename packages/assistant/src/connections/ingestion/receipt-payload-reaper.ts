/**
 * Retention for the BODY of an `event_receipts` row (#1177 follow-up).
 *
 * `event_receipts` is 135 MB and grows about 0.54 MB a day, and migration 0134
 * made it append-only by trigger, so nothing ever pruned it. Most of that is
 * `payload`: about 100 MB at an average 3,770 bytes a row. The receipt is a
 * different question from the body, and only the body has an expiry.
 *
 * What expires, and what does not. `(provider, provider_delivery_id)` is the
 * UNIQUE index that makes a redelivery a no-op through `onConflictDoNothing`,
 * and `history_id` is the cursor Gmail gap detection MAXes, so a row delete
 * would forfeit both — a provider redelivering an old event would be ingested
 * as new, producing a second delivery and therefore a second run of whatever
 * the user triggered on it. GitHub's "Redeliver" button works on months-old
 * deliveries, so that window is unbounded. So this module releases `payload` to
 * NULL and leaves the row, its audit columns, and its dedup key alone. The
 * trigger permits that one transition (migration 0139) and this is the module
 * that decides when to make it.
 *
 * **Release, not reap.** Nothing is deleted, and the codebase already says
 * "released to NULL" for this column. The file keeps the reaper name because
 * the scheduled task is a reaper and the sibling module is one too; the
 * exported operation says what it actually does.
 *
 * **What a release does to storage, precisely.** The body is TOASTed, and an
 * UPDATE that nulls it frees those chunks for REUSE once autovacuum runs. It
 * does not shrink the table file. So the volume STOPS GROWING; it does not
 * fall, and nothing here reclaims bytes already written. That is the whole
 * win: `payload` is the growth term, and bounding it is what keeps the table
 * off the volume ceiling.
 *
 * **What a release costs.** `payload` is read, and a released row is read as an
 * absent one. The degradations are named rather than waved away, because "no
 * reader touches this column" was the claim that had to be replaced:
 *
 *   - `gatherIntegrationActivity` (`packages/assistant/src/briefings/gather.ts`)
 *     renders integration activity for `get_day_shape` and `gatherBriefing`.
 *     With no body, `describeGithubReceipt` parses `{}` and the line degrades to
 *     a generic one, and the `seenDeployments` collapse (#1167) is lost, so one
 *     relayed machine deployment reads as several units of the user's day.
 *   - The github object-state rebuild
 *     (`packages/assistant/src/connections/object-state/backfill-object-state-github-committed.ts`)
 *     replays stored `pull_request` bodies and skips a released one silently,
 *     so a rebuild from receipts covers only this window. Nothing recovers it.
 *
 *   The authoritative reader list, with all five readers and what each does
 *   when the body is gone, is frozen in the header of
 *   `packages/db/src/migrations/0139_receipt_payload_retention.sql`. It is
 *   referenced rather than copied because a migration is hashed at merge and
 *   cannot be restated here without going stale twice.
 *
 * **Both tiers.** Raw receipts (`raw_kind` set, ADR-0097 item 9) carry bodies
 * too and grow on the same curve, so this reads `eventReceipts` rather than
 * `typedEventReceipts` and is registered with the `unfiltered-event-receipt-read`
 * gate. Reading only the typed tier would leave the same unbounded growth on a
 * smaller table.
 */
import { db } from "@alfred/db";
import { documents, eventReceipts } from "@alfred/db/schemas";
import { and, asc, eq, exists, isNotNull, lt, sql } from "drizzle-orm";
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { receiptDocumentJoin } from "./receipt-document";

/**
 * How long a receipt keeps its body.
 *
 * This is a tradeoff, chosen and not deduced, and it is worth being plain about
 * which reader it trades against. The one in-product reader of an OLD body is
 * `gatherIntegrationActivity`, and its window is not all history: `get_day_shape`
 * passes `sinceIngestedAt` (the last briefing) to now, and `gatherBriefing`
 * passes `args.windowStart ?? 24h`. Nothing in the product asks for a body
 * older than that, so 90 days sits comfortably outside anything a reader asks
 * for and buys two things instead: debug visibility on rows whose consumer has
 * stopped asking, and an object-state rebuild that covers 90 days of deliveries
 * rather than none.
 *
 * A longer window would cost a proportionally larger table and buy no reader. A
 * shorter one would cost the rebuild and the visibility. 90 days is where that
 * balance landed, and the owner chose it deliberately; the argument is recorded
 * in ADR-0109, not here, because a constant's docstring is not where a
 * decision is recorded.
 */
export const RECEIPT_PAYLOAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Rows released per statement.
 *
 * Not the outbox reaper's 5,000, and the number is measured rather than
 * copied. This statement carries an `EXISTS` clause against `documents`, so a
 * page larger than the number of matching rows abandons the partial index for a
 * sort plus a hash join: at `LIMIT 1000` the plan is a nested loop over
 * `event_receipts_payload_live_idx` and `documents_source_id_idx`, and at
 * `LIMIT 5000` the planner abandons `event_receipts_payload_live_idx`
 * entirely. Item 01's index is worth nothing if the page is allowed to grow
 * past the live set, so the bound sits inside the measured cliff.
 */
export const RELEASE_BATCH_SIZE = 1_000;

/** Statements per pass, so a first-run backlog spreads over passes. */
export const MAX_BATCHES_PER_PASS = 20;

/**
 * A pass with both bounds lowered, so a test can engage them without seeding
 * `RELEASE_BATCH_SIZE * MAX_BATCHES_PER_PASS` rows.
 *
 * The bounds are parameters for the same reason `now` is: at their production
 * values the paging behavior needs 20,001 rows to become observable, so it would
 * go untested and a mutant that removed either bound would survive. The
 * defaults are the contract; the parameters only make it cheap to watch.
 */
export interface ReleaseOptions {
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
 * Release one bounded page of expired bodies.
 *
 * The id page is selected in a subquery so the `UPDATE` targets a fixed set
 * rather than re-evaluating the predicate against rows being delivered
 * concurrently. `processing_status` only ever moves pending -> completed|failed
 * (`markProcessed` in `inbound-deliver.ts`), so a row that was `completed` at
 * page time cannot become releasable-in-error between the two statements.
 *
 * **The predicate has four clauses and each one is load-bearing.**
 *
 *   payload IS NOT NULL              literal, so the planner may use
 *                                    `event_receipts_payload_live_idx`, whose
 *                                    predicate is exactly this
 *   delivered_at < cutoff            the index condition; this is what makes
 *                                    expiry track the live bodies rather than
 *                                    the age of the table
 *   processing_status = 'completed'  literal equality, NOT `<> 'failed'`. A
 *                                    redelivery re-enqueues any non-completed
 *                                    receipt at any age, and the deliver job
 *                                    publishes a POINTER that the object-state
 *                                    fold resolves by reading `payload` later —
 *                                    so a `failed` OR `pending` receipt can
 *                                    still need its body, and releasing it makes
 *                                    the retry fold nothing
 *   EXISTS corpus document           a receipt with no document is the only
 *                                    source for the projection
 *                                    `receipt-corpus-backfill.ts` will build,
 *                                    and that projection is not recoverable
 *                                    afterwards: `describe` never refuses a
 *                                    null, so a released receipt yields a
 *                                    HOLLOW document the `notExists` filter
 *                                    then stops selecting. This clause makes
 *                                    the reaper wait for the backfill instead
 *                                    of outrunning it, which both drain the
 *                                    oldest end of the same table
 *
 * **`= any(array(...))`, not `in (...)`.** The two look interchangeable and are
 * not. With `id in (subquery)` Postgres plans a Hash Semi Join and reads every
 * row in the table to find the page; wrapping the subquery in `array()` makes it
 * an InitPlan whose result feeds an `Index Cond` on the primary key. Measured on
 * an 800k-row copy of the sibling table, that is 91ms against 2.5ms. Re-plan
 * with `EXPLAIN (ANALYZE, BUFFERS)` before changing this.
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
    // By `delivered_at`, not by `id`: ids are `createId("evr")` nanoids, which
    // are random rather than monotonic, so id order is not age order and does not
    // match the partial index. Oldest-first is also the drain order the corpus
    // backfill uses, so a backlog empties from one end instead of leaving holes.
    .orderBy(asc(eventReceipts.deliveredAt))
    .limit(batchSize);

  const released = await db()
    .update(eventReceipts)
    // A literal null, never a sql.placeholder: a placeholder encodes JS null as
    // JSON 'null', which the write-once guard reads as a replacement body and
    // refuses.
    .set({ payload: null })
    .where(sql`${eventReceipts.id} = any(array(${page}))`)
    .returning({ id: eventReceipts.id });

  return released.length;
}

/** Serializes the exported pass against the scheduled one. See the export. */
let passInFlight = false;

/**
 * Run one retention pass. Returns the number of bodies released.
 *
 * Two passes must not overlap. They would select the same id page, and the
 * loser's `UPDATE` would match nothing while both held pool connections. The
 * scheduler's own re-entrancy guard is not enough, because this function is
 * exported: a script or a future admin route calling it directly would run
 * alongside the hourly timer. So the guard lives here, on the entrypoint, and a
 * caller who arrives during a pass gets `0` rather than a redundant scan.
 *
 * `signal` is what makes the pass interruptible — without a check between
 * batches, a shutdown would abandon a pass mid-flight and the pool could close
 * under an open `UPDATE`.
 *
 * `now` stays a positional parameter rather than joining the options object, and
 * that is deliberate: every property of `ReleaseOptions` is optional, so a stray
 * `releaseExpiredReceiptPayloadsOnce(someDate)` would type-check as an options
 * bag with no `now`, silently release against the real clock, and pass. Nothing
 * would catch it — this package's `tsc` covers `src` only, so test files are
 * unchecked.
 */
export async function releaseExpiredReceiptPayloadsOnce(
  now: Date = new Date(),
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
      // Between batches, never inside one: a half-released page is fine (the
      // next pass finds the rest) but an abandoned open UPDATE is not.
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
  // One pass at boot, so a process that restarts more often than the interval
  // still releases.
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

/** Exported for tests that need to observe the scheduler rather than one pass. */
export function isReceiptPayloadReaperRunning(): boolean {
  return !reaper.stopped;
}
