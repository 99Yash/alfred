import { getMemoryQueue, type MemoryJobData } from "./queue";

/**
 * Boot-time repeatable memory jobs (ADR-0019, ADR-0025 #3): daily extraction,
 * a 5-minute embed sweep, and the daily drift health check (#219).
 * `upsertJobScheduler` keys by id, so a reboot does not duplicate schedules.
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

  // Rides this queue: it reads the same tables as the daily extraction.
  await queue.upsertJobScheduler(
    "memory.drift_health_check",
    { every: 24 * 60 * 60 * 1000 },
    {
      name: "memory.drift_health_check",
      data: { kind: "memory.drift_health_check" } satisfies MemoryJobData,
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
        removeOnFail: { count: 30, age: 90 * 24 * 60 * 60 },
      },
    },
  );
}
