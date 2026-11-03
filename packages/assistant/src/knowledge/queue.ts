import { z } from "zod";
import { defineQueue, job, signal } from "@alfred/assistant/queue-jobs";

/**
 * Memory-cron queue: repeatable jobs that fan out into per-user runs (ADR-0019, ADR-0025 #3).
 * The worker is `worker.ts`.
 */
export const memoryQueue = defineQueue({
  name: "memory-cron",
  jobs: {
    /** Repeatable: one run per active user. */
    "memory.extract.daily": signal(),
    /** Ad-hoc run for one user. No producer adds it today; a job already in Redis still runs. */
    "memory.extract.run": job(z.object({ userId: z.string().min(1) })),
    /** Repeatable: embed chunks written without one. */
    "memory.embed_sweep": signal(),
    /** Repeatable drift health check (#219). Shares this queue to save Redis connections. */
    "memory.drift_health_check": signal(),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 20, age: 7 * 24 * 60 * 60 },
    removeOnFail: { count: 50, age: 30 * 24 * 60 * 60 },
  },
});
