import { workflowsQueue } from "./queue";
import { dispatchDueCronWorkflows } from "./tick";

/**
 * The `workflows-tick` worker. The per-minute `workflows.tick` schedule is written at boot.
 */
export const workflowsWorker = workflowsQueue.consume({
  label: "workflows",
  // The handler is cheap; one at a time is right.
  concurrency: 1,
  handlers: {
    "workflows.tick": async () => dispatchDueCronWorkflows(),
  },
  schedules: [
    {
      kind: "workflows.tick",
      repeat: { every: 60 * 1000 },
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 120, age: 4 * 60 * 60 },
        removeOnFail: { count: 200, age: 24 * 60 * 60 },
      },
    },
  ],
});
