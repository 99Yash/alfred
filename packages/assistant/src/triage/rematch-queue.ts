import { createRedisConnection } from "@alfred/db/redis";
import { logger } from "@alfred/logging";
import { Queue, Worker, type Job } from "bullmq";
import { TRIAGE_REMATCH_SWEEP_EVERY_MS } from "./constants";
import { rematchStandingInstructions, usersBehindRematch } from "./rematch";

/**
 * The standing-instruction re-match queue (ADR-0113, "Re-match after a change"; plan decision
 * 20). A sweep enqueues each user whose instruction-set `revision` is ahead of
 * `rematched_revision`. A triage write that read an older set enqueues its user too.
 */
const TRIAGE_REMATCH_QUEUE_NAME = "triage-rematch";

export type TriageRematchJobData =
  /** Repeatable: enqueue a re-match for each user that is behind. */
  | { kind: "triage.rematch.sweep" }
  /** Re-match one user's recent mail against the current instruction set. */
  | { kind: "triage.rematch.user"; userId: string };

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
      removeOnFail: { count: 50, age: 24 * 60 * 60 },
    },
  });

  return _queue;
}

/**
 * One job for each user at a time. An add while the user's job runs is kept and runs after
 * it, so a write during the job is not lost and two jobs never write the same rows at once.
 */
export async function enqueueTriageRematch(userId: string): Promise<void> {
  await getTriageRematchQueue().add(
    "triage.rematch.user",
    { kind: "triage.rematch.user", userId },
    { deduplication: { id: `triage.rematch.user.${userId}`, keepLastIfActive: true } },
  );
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
    { every: TRIAGE_REMATCH_SWEEP_EVERY_MS },
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

async function processTriageRematchJob(
  job: Job<TriageRematchJobData>,
  _token?: string,
  signal?: AbortSignal,
) {
  const data = job.data;

  switch (data.kind) {
    case "triage.rematch.sweep": {
      const behind = await usersBehindRematch();

      for (const userId of behind) await enqueueTriageRematch(userId);

      return { behind: behind.length };
    }

    case "triage.rematch.user":
      return rematchStandingInstructions({
        userId: data.userId,
        signal,
        // `attemptsMade` counts the failed attempts before this one.
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      });
  }
}
