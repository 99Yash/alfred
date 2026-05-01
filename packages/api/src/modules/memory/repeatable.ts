import { getMemoryQueue, type MemoryJobData } from "./queue";

/**
 * Daily trigger for the memory-extraction workflow (ADR-0019, ADR-0025 #3).
 * Idempotent: `upsertJobScheduler` keys by id, so repeated boots don't
 * duplicate schedules.
 *
 * 24h cadence — the extractor's per-doc dedup (`memory_extraction_status`)
 * means a faster cycle would mostly re-walk the same window. End-of-thread
 * + event-triggered extraction (the other two paths in ADR-0019) plug into
 * `enqueueExtractionForUser` directly when they exist.
 */
export async function scheduleRepeatableMemoryJobs(): Promise<void> {
  const queue = getMemoryQueue();

  await queue.upsertJobScheduler(
    "memory.extract.daily",
    { every: 24 * 60 * 60 * 1000 },
    {
      name: "memory.extract.daily",
      data: { kind: "memory.extract.daily" } satisfies MemoryJobData,
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 90 * 24 * 60 * 60 },
      },
    },
  );
}
