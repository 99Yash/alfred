import { createRedisConnection } from "@alfred/db/redis";
import { logger } from "@alfred/logging";
import { Queue, Worker, type Job } from "bullmq";
import { rematchStandingInstructions, usersBehindRematch } from "./rematch";

/**
 * The standing-instruction re-match queue (ADR-0113, "Re-match after a change"). A sweep is
 * the only trigger: it finds each user whose instruction-set `revision` is ahead of
 * `rematched_revision` and enqueues one job for that revision. So every writer reaches old
 * mail, also a memory-page edit or a script that never enqueues. The lag is one sweep period.
 */
const TRIAGE_REMATCH_QUEUE_NAME = "triage-rematch";

const SWEEP_EVERY_MS = 60_000;

export type TriageRematchJobData =
  /** Repeatable: enqueue a re-match for each user that is behind. */
  | { kind: "triage.rematch.sweep" }
  /** Re-match one user's recent mail at the set revision the sweep saw. */
  | { kind: "triage.rematch.user"; userId: string; revision: number };

let _queue: Queue<TriageRematchJobData> | undefined;

let _worker: Worker<TriageRematchJobData> | undefined;

export function getTriageRematchQueue(): Queue<TriageRematchJobData> {
  if (_queue) return _queue;
  _queue = new Queue<TriageRematchJobData>(TRIAGE_REMATCH_QUEUE_NAME, {
    connection: createRedisConnection("queue"),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 50, age: 24 * 60 * 60 },
      // The job id holds the revision, so a failed job blocks the same revision until it
      // leaves the failed set. Then the next sweep enqueues it again.
      removeOnFail: { age: 60 * 60 },
    },
  });

  return _queue;
}

export async function startTriageRematchWorker(): Promise<void> {
  if (_worker) return;
  // Two slots, so a long user job does not hold the sweep.
  _worker = new Worker<TriageRematchJobData>(TRIAGE_REMATCH_QUEUE_NAME, processTriageRematchJob, {
    connection: createRedisConnection("queue"),
    concurrency: 2,
  });
  _worker.on("error", (err) => {
    logger.error({ err }, "[triage.rematch:worker] error");
  });
}

export async function stopTriageRematchWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}

export async function closeTriageRematchQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

/** `upsertJobScheduler` keys by id, so a reboot does not duplicate the schedule. */
export async function scheduleRepeatableTriageRematchJobs(): Promise<void> {
  await getTriageRematchQueue().upsertJobScheduler(
    "triage.rematch.sweep",
    { every: SWEEP_EVERY_MS },
    {
      name: "triage.rematch.sweep",
      data: { kind: "triage.rematch.sweep" } satisfies TriageRematchJobData,
      opts: {
        attempts: 1,
        removeOnComplete: { count: 10, age: 60 * 60 },
        removeOnFail: { count: 50, age: 24 * 60 * 60 },
      },
    },
  );
}

async function processTriageRematchJob(job: Job<TriageRematchJobData>) {
  const data = job.data;

  switch (data.kind) {
    case "triage.rematch.sweep": {
      const behind = await usersBehindRematch();
      const queue = getTriageRematchQueue();

      // BullMQ ids cannot hold `:`. A job id that exists already is not added again.
      for (const { userId, revision } of behind) {
        await queue.add(
          "triage.rematch.user",
          { kind: "triage.rematch.user", userId, revision },
          { jobId: `standing-rematch.${userId}.${revision}` },
        );
      }

      return { behind: behind.length };
    }

    case "triage.rematch.user":
      return rematchStandingInstructions({ userId: data.userId });
  }
}
