import { defineQueue, signal } from "@alfred/assistant/queue-jobs";

/**
 * Workflow dispatch queue (ADR-0027). It only drives the per-minute `workflows.tick`.
 * Each row is one `startRunInTx` (claim and create in one transaction, enqueue after commit).
 * `briefing-cron` and `memory-cron` are separate queues. The worker is `worker.ts`.
 */
export const workflowsQueue = defineQueue({
  name: "workflows-tick",
  jobs: {
    "workflows.tick": signal(),
  },
  defaults: {
    attempts: 2,
    backoff: { type: "exponential", delay: 30_000 },
    // Ticks every minute; keep a short history so Redis does not fill up.
    removeOnComplete: { count: 120, age: 4 * 60 * 60 },
    removeOnFail: { count: 200, age: 24 * 60 * 60 },
  },
});
