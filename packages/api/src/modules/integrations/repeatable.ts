import { getIngestionQueue, type IngestionJobData } from "./queue";

/**
 * Boot-time registration for the m7c repeatable jobs:
 *
 *   - gmail.poll_sweep   every 5 minutes — polls credentials whose
 *                        cursor hasn't advanced via webhook recently.
 *                        Backstop for Pub/Sub gaps + the "watch
 *                        channel never installed" case.
 *   - gmail.watch_renew  every 6 hours — replaces watch channels
 *                        nearing their ~7-day expiry. Daily would be
 *                        fine, but 6h means a single failed run still
 *                        leaves margin to retry before expiry.
 *   - gmail.embed_sweep  every 10 minutes — re-embeds documents whose
 *                        embed step failed during ingest (the doc row
 *                        landed but no chunks were produced).
 *   - user_model.gmail_kind_refold_sweep  daily — fans out a Gmail
 *                        kind-projection refold to every user with an
 *                        ACTIVE projection (#218 PR J). Backstop for
 *                        missed live-capture refolds / out-of-band
 *                        backfills; each per-user refold passes the
 *                        frozen-logic gate before it activates.
 *
 * Idempotent: `upsertJobScheduler` keys by id, so calling this on every
 * server boot doesn't duplicate schedules. The schedulers survive
 * restarts in Redis.
 */
export async function scheduleRepeatableIngestionJobs(): Promise<void> {
  const queue = getIngestionQueue();

  await queue.upsertJobScheduler(
    "gmail.poll_sweep",
    { every: 5 * 60 * 1000 },
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
