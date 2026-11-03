import { z } from "zod";
import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { defineQueue, job, keyedJob } from "@alfred/assistant/queue-jobs";
import { getWorkflow } from "./registry";

/**
 * BullMQ takes every job with no priority before any prioritized job, so a bulk step runs only
 * when no other step waits. Jobs of one priority keep their FIFO order.
 */
const BULK_JOB_PRIORITY = 1;

const runRef = z.object({ runId: z.string().min(1) });

/**
 * The agent step queue. Two jobs for one run are safe: the DB lease lets only one run it.
 * The worker is `worker.ts`.
 */
export const agentQueue = defineQueue({
  name: "agent-runs",
  jobs: {
    /** One step of a run. Any number may exist; the DB lease lets one run at a time. */
    step: job(runRef),
    /**
     * The first step of a run whose producer can retry: a cron occurrence or a sub-agent spawn.
     * The job id is the run id, so a retried producer adds nothing while the job is kept.
     * BullMQ job ids cannot contain `:`.
     */
    start: keyedJob(runRef, { key: ["runId"], id: ({ runId }) => `run-start.${runId}` }),
  },
  defaults: {
    // Job retries only; the run row owns step attempts.
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 100, age: 60 * 60 },
    removeOnFail: { count: 200, age: 24 * 60 * 60 },
  },
});

/** How to add a run's job. `once` adds the `start` kind; anything else adds a `step`. */
export interface EnqueueRunOpts {
  readonly delayMs?: number;
  /** The first step of a run whose producer can retry. A retry adds nothing (ADR-0027). */
  readonly once?: boolean;
}

/** Add a job for `runId`. A bulk run gets the low priority. */
export async function enqueueRun(runId: string, opts: EnqueueRunOpts = {}): Promise<void> {
  const bulk = await isBulkRun(runId);

  await agentQueue.add(
    opts.once ? "start" : "step",
    { runId },
    {
      ...(opts.delayMs === undefined ? {} : { delay: opts.delayMs }),
      ...(bulk ? { priority: BULK_JOB_PRIORITY } : {}),
    },
  );
}

/** A missing row or an unregistered slug is not bulk, so the step keeps the normal order. */
async function isBulkRun(runId: string): Promise<boolean> {
  const [row] = await db()
    .select({ workflowSlug: agentRuns.workflowSlug })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  return row ? getWorkflow(row.workflowSlug)?.bulk === true : false;
}
