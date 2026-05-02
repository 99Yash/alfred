import { getMemoryQueue, type MemoryJobData } from "./queue";

/**
 * Boot-time registration for memory-side repeatable jobs (ADR-0019, ADR-0025 #3).
 *
 *   - memory.extract.daily  every 24h — fans out into per-user
 *                           memory-extraction runs. Per-doc dedup via
 *                           memory_extraction_status keeps re-runs cheap.
 *   - memory.embed_sweep    every 5m — backfills embeddings for
 *                           memory_chunks written through the
 *                           write-then-embed path (extraction-run
 *                           summaries, end-of-thread distillations).
 *                           Mirrors the m7c `gmail.embed_sweep` pattern.
 *
 * Idempotent: `upsertJobScheduler` keys by id, so repeated boots don't
 * duplicate schedules.
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

  await queue.upsertJobScheduler(
    "memory.embed_sweep",
    { every: 5 * 60 * 1000 },
    {
      name: "memory.embed_sweep",
      data: { kind: "memory.embed_sweep" } satisfies MemoryJobData,
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 20, age: 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 7 * 24 * 60 * 60 },
      },
    },
  );
}
