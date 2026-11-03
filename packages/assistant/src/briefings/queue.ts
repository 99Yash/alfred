import { defineQueue, signal } from "@alfred/assistant/queue-jobs";

/**
 * Briefing cron queue (ADR-0025 #2). It only triggers runs; the workflow runs on the agent queue.
 * Separate because the tick fans out to users whose local hour matches, which is not
 * one `next_run_at`. Same pattern as `memory-cron`. The worker is `worker.ts`.
 */
export const briefingQueue = defineQueue({
  name: "briefing-cron",
  jobs: {
    /** Hourly; fans out to matching users. */
    "briefing.tick": signal(),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
    removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
  },
});
