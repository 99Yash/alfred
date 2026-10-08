import { getBriefingQueue, type BriefingJobData } from "./queue";

/**
 * Register the hourly `briefing.tick` at boot. Hourly is enough for a daily email (ADR-0025).
 * `upsertJobScheduler` keys by id, so reboots do not duplicate it.
 */
export async function scheduleRepeatableBriefingJobs(): Promise<void> {
  const queue = getBriefingQueue();

  await queue.upsertJobScheduler(
    "briefing.tick",
    { every: 60 * 60 * 1000 },
    {
      name: "briefing.tick",
      data: { kind: "briefing.tick" } satisfies BriefingJobData,
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 24, age: 7 * 24 * 60 * 60 },
        removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
      },
    },
  );
}
