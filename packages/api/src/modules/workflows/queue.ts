import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "../../queue/connection";
import { dispatchDueCronWorkflows } from "./tick";

/**
 * Generic workflow-dispatch queue (ADR-0027).
 *
 * Mirrors `briefing-cron` in shape but its only responsibility is to
 * drive the per-minute `workflows.tick` repeatable. The tick query is a
 * partial-index scan on `workflows.next_run_at`; per-row work is
 * `createRun({ trigger: cron, ... }) → enqueueRun({ jobId })`.
 *
 * Distinct from the per-feature `briefing-cron` and `memory-cron` queues
 * to keep the operational lanes obvious: one queue per dispatch
 * cadence. m12 ships this as a sibling; a follow-up pass migrates the
 * per-feature ticks onto this one and retires them.
 */
export const WORKFLOWS_QUEUE_NAME = "workflows-tick";

export type WorkflowsJobData = { kind: "workflows.tick" };

let _queue: Queue<WorkflowsJobData> | undefined;
let _worker: Worker<WorkflowsJobData> | undefined;

export function getWorkflowsQueue(): Queue<WorkflowsJobData> {
  if (_queue) return _queue;
  _queue = new Queue<WorkflowsJobData>(WORKFLOWS_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      // Tick fires every minute; keep a tight rolling history so a
      // restart doesn't flood Redis with old data.
      removeOnComplete: { count: 120, age: 4 * 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });
  return _queue;
}

export interface StartWorkflowsWorkerOpts {
  concurrency?: number;
}

export async function startWorkflowsWorker(
  opts: StartWorkflowsWorkerOpts = {},
): Promise<void> {
  if (_worker) return;
  _worker = new Worker<WorkflowsJobData>(WORKFLOWS_QUEUE_NAME, processWorkflowsJob, {
    connection: createRedisConnection(),
    // The tick handler is cheap (one indexed SELECT + a small per-row
    // enqueue loop); single-threaded is right.
    concurrency: opts.concurrency ?? 1,
  });
  _worker.on("error", (err) => {
    console.error("[workflows:worker] error:", err.message);
  });
}

export async function stopWorkflowsWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}

export async function closeWorkflowsQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

async function processWorkflowsJob(job: Job<WorkflowsJobData>): Promise<unknown> {
  switch (job.data.kind) {
    case "workflows.tick":
      return dispatchDueCronWorkflows();
    default: {
      const _exhaustive: never = job.data.kind;
      throw new Error(`unknown workflows job kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Idempotent boot-time registration of the `workflows.tick` repeatable.
 * Mirrors `scheduleRepeatableBriefingJobs` — `upsertJobScheduler` keys
 * by id, so re-boots don't duplicate schedules.
 */
export async function scheduleRepeatableWorkflowsJobs(): Promise<void> {
  const queue = getWorkflowsQueue();
  await queue.upsertJobScheduler(
    "workflows.tick",
    { every: 60 * 1000 },
    {
      name: "workflows.tick",
      data: { kind: "workflows.tick" } satisfies WorkflowsJobData,
      opts: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 120, age: 4 * 60 * 60 },
        removeOnFail: { count: 200, age: 24 * 60 * 60 },
      },
    },
  );
}
