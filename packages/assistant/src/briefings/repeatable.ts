import { getBriefingQueue, type BriefingJobData } from "./queue";

/**
 * Boot-time registration for the briefing-cron repeatables.
 *
 *   - briefing.tick  every 1 hour — fan out to users whose local
 *                    delivery_hour matches the current local hour.
 *
 * The hour granularity is deliberate: per ADR-0025, briefings are a
 * once-a-day event, and per-minute precision is unnecessary. An hourly
 * tick + per-user idempotency in `email_sends` is plenty.
 *
 * Idempotent: `upsertJobScheduler` keys by id, so re-boots don't
 * duplicate schedules.
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
