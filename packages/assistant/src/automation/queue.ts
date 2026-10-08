import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "@alfred/db/redis";
import { dispatchDueCronWorkflows } from "./tick";

/**
 * Workflow dispatch queue (ADR-0027). It only drives the per-minute `workflows.tick`.
 * Each row is one `startRunInTx` (claim and create in one transaction, enqueue after commit).
 * `briefing-cron` and `memory-cron` are separate queues.
 */
const WORKFLOWS_QUEUE_NAME = "workflows-tick";

export type WorkflowsJobData = { kind: "workflows.tick" };

let _queue: Queue<WorkflowsJobData> | undefined;

let _worker: Worker<WorkflowsJobData> | undefined;

export function getWorkflowsQueue(): Queue<WorkflowsJobData> {
  if (_queue) return _queue;
  _queue = new Queue<WorkflowsJobData>(WORKFLOWS_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      // Ticks every minute; keep a short history so Redis does not fill up.
      removeOnComplete: { count: 120, age: 4 * 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });

  return _queue;
}

export interface StartWorkflowsWorkerOpts {
  concurrency?: number;
}

export async function startWorkflowsWorker(opts: StartWorkflowsWorkerOpts = {}): Promise<void> {
  if (_worker) return;
  _worker = new Worker<WorkflowsJobData>(WORKFLOWS_QUEUE_NAME, processWorkflowsJob, {
    connection: createRedisConnection("queue"),
    // The handler is cheap; one at a time is right.
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

/** Register the tick at boot. `upsertJobScheduler` keys by id, so reboots do not duplicate it. */
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
