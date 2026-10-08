import { GMAIL_POLL_SWEEP_INTERVAL_MS } from "./gmail-delivery-policy";
import { getIngestionQueue, type IngestionJobData } from "./queue";

/**
 * Register the repeatable ingestion jobs at boot. Idempotent: `upsertJobScheduler` keys by id.
 * - `gmail.poll_sweep`: backstop for missed Pub/Sub pushes and missing watches.
 * - `gmail.watch_renew` every 6h: watches expire after about 7 days; 6h leaves room for a failed
 *   run.
 * - `gmail.embed_sweep`: index chunkless docs and project older receipts with no document.
 * - `ingress.health_sweep` every 6h: a broken source sends nothing, so only a schedule notices
 *   (ADR-0100).
 * - `user_model.gmail_kind_refold_sweep` daily: backstop for missed live refolds.
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
