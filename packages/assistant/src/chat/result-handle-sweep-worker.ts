/**
 * The daily sweep of expired result handles (ADR-0087 point 2: GC on expiry). Ungated: it deletes
 * only Alfred's own stored copies, so it also runs in dev, where scheduled jobs are off.
 */
import { logger } from "@alfred/logging";
import { defineQueue, signal } from "@alfred/assistant/queue-jobs";
import { sweepExpiredResultHandles } from "./result-handle-store";

const DAY_MS = 24 * 60 * 60 * 1000;

const resultHandleSweepQueue = defineQueue({
  name: "result-handle-sweep",
  jobs: {
    /** Repeatable: delete expired `result_handles` rows and their objects. */
    "chat.result_handles.sweep": signal(),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 10 * 60_000 },
    removeOnComplete: { count: 7, age: 30 * 24 * 60 * 60 },
    removeOnFail: { count: 30, age: 90 * 24 * 60 * 60 },
  },
});

/** The `result-handle-sweep` worker and its daily schedule. */
export const resultHandleSweepWorker = resultHandleSweepQueue.consume({
  label: "result-handle-sweep",
  concurrency: 1,
  ungated: true,
  handlers: {
    "chat.result_handles.sweep": async () => {
      const removed = await sweepExpiredResultHandles();

      logger.info(`[result-handle-sweep:worker] chat.result_handles.sweep removed=${removed}`);

      return { removed };
    },
  },
  schedules: [{ kind: "chat.result_handles.sweep", repeat: { every: DAY_MS } }],
});
