import { GMAIL_POLL_SWEEP_INTERVAL_MS } from "./gmail-delivery-policy";
import { getIngestionQueue, type IngestionJobData } from "./queue";

/**
 * Boot-time registration for the m7c repeatable jobs:
 *
 *   - gmail.poll_sweep   every GMAIL_POLL_SWEEP_INTERVAL_MS (5 minutes) —
 *                        polls every active Gmail cursor. Backstop for Pub/Sub gaps +
 *                        the "watch channel never installed" case.
 *   - gmail.watch_renew  every 6 hours — replaces watch channels
 *                        nearing their ~7-day expiry. Daily would be
 *                        fine, but 6h means a single failed run still
 *                        leaves margin to retry before expiry.
 *   - gmail.embed_sweep  every 10 minutes — indexes chunkless Gmail and
 *                        inbound receipt documents. Also projects older
 *                        inbound receipts that have no corpus document.
 *   - user_model.gmail_kind_refold_sweep  daily — fans out a Gmail
 *                        kind-projection refold to every user with an
 *                        ACTIVE projection (#218 PR J). Backstop for
 *                        missed live-capture refolds / out-of-band
 *                        backfills; each per-user refold passes the
 *                        frozen-logic gate before it activates.
 *   - ingress.health_sweep  every 6 hours — pulls each event source's own
 *                        delivery health and emails the user about one that
 *                        stopped delivering (ADR-0100). A broken source sends
 *                        nothing, so no push signal exists and only a schedule
 *                        can notice. Six hours, not daily: the email is rate
 *                        limited to one per source per week, so the interval
 *                        only bounds how long a break stays unreported, and a
 *                        single failed run still has three more before the day
 *                        is out.
 *
 * Idempotent: `upsertJobScheduler` keys by id, so calling this on every
 * server boot doesn't duplicate schedules. The schedulers survive
 * restarts in Redis.
 */
export async function scheduleRepeatableIngestionJobs(): Promise<void> {
  const queue = getIngestionQueue();

  await queue.upsertJobScheduler(
    "gmail.poll_sweep",
    { every: GMAIL_POLL_SWEEP_INTERVAL_MS },
    {
      name: "gmail.poll_sweep",
      data: { kind: "gmail.poll_sweep" } satisfies IngestionJobData,
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 20, age: 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
      },
    },
  );

  await queue.upsertJobScheduler(
    "gmail.watch_renew",
    { every: 6 * 60 * 60 * 1000 },
    {
      name: "gmail.watch_renew",
      data: { kind: "gmail.watch_renew" } satisfies IngestionJobData,
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 10, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 30 * 24 * 60 * 60 },
      },
    },
  );

  await queue.upsertJobScheduler(
    "gmail.embed_sweep",
    { every: 10 * 60 * 1000 },
    {
      name: "gmail.embed_sweep",
      data: { kind: "gmail.embed_sweep" } satisfies IngestionJobData,
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 20, age: 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
      },
    },
  );

  await queue.upsertJobScheduler(
    "ingress.health_sweep",
    { every: 6 * 60 * 60 * 1000 },
    {
      name: "ingress.health_sweep",
      data: { kind: "ingress.health_sweep" } satisfies IngestionJobData,
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 10, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 30 * 24 * 60 * 60 },
      },
    },
  );

  await queue.upsertJobScheduler(
    "user_model.gmail_kind_refold_sweep",
    { every: 24 * 60 * 60 * 1000 },
    {
      name: "user_model.gmail_kind_refold_sweep",
      data: { kind: "user_model.gmail_kind_refold_sweep" } satisfies IngestionJobData,
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 30 * 24 * 60 * 60 },
      },
    },
  );
}
