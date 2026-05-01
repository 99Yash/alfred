import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../../queue/connection";
import { runOnce } from "./executor";
import { AGENT_QUEUE_NAME, enqueueRun, type AgentJobData } from "./queue";
import { findResumableRunIds, heartbeatRun, STALE_RUN_LEASE_MS } from "./service";

/**
 * Heartbeat cadence. Worker bumps `last_checkpoint_at` on the active run
 * every interval so the resume sweep won't reclaim it during a long step.
 * Pick a value comfortably below `STALE_RUN_LEASE_MS` so a single missed
 * heartbeat doesn't cause a false-positive reclaim.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

const RESUME_SWEEP_INTERVAL_MS = 30_000;

let _worker: Worker<AgentJobData> | undefined;
let _resumeTimer: ReturnType<typeof setInterval> | undefined;

export interface StartAgentWorkerOpts {
  /** Max parallel runs handled by this process. Each run is a single step at a time. */
  concurrency?: number;
}

/**
 * Boot the worker: subscribes to the BullMQ queue, runs an immediate resume
 * sweep, then starts a periodic sweep. Returns immediately once ready.
 */
export async function startAgentWorker(opts: StartAgentWorkerOpts = {}): Promise<void> {
  if (_worker) return;
  const concurrency = opts.concurrency ?? 4;

  _worker = new Worker<AgentJobData>(AGENT_QUEUE_NAME, processAgentJob, {
    connection: createRedisConnection(),
    concurrency,
    // BullMQ's stalled-job mechanism is our last-line backstop if the
    // process dies between heartbeats. Tighter than the resume sweep so
    // BullMQ-side retries cover most cases without waiting for the sweep.
    stalledInterval: 30_000,
    maxStalledCount: 1,
  });

  _worker.on("error", (err) => {
    console.error("[agent:worker] error:", err.message);
  });

  // Immediate resume sweep — anything left mid-flight by a previous deploy
  // gets picked up before the worker idles.
  await resumeSweep();

  _resumeTimer = setInterval(() => {
    void resumeSweep();
  }, RESUME_SWEEP_INTERVAL_MS);
  if (typeof _resumeTimer === "object" && "unref" in _resumeTimer) {
    _resumeTimer.unref();
  }
}

async function processAgentJob(job: Job<AgentJobData>): Promise<void> {
  const { runId } = job.data;
  const heartbeat = setInterval(() => {
    void heartbeatRun(runId).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat === "object" && "unref" in heartbeat) {
    heartbeat.unref();
  }

  try {
    const outcome = await runOnce(runId);
    // If the run advanced, immediately re-enqueue so the next step picks
    // up without waiting for a sweep — keeps short workflows snappy.
    if (outcome.kind === "advanced") {
      await enqueueRun(runId);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function resumeSweep(): Promise<void> {
  try {
    const ids = await findResumableRunIds({ staleAfterMs: STALE_RUN_LEASE_MS, limit: 50 });
    for (const id of ids) {
      await enqueueRun(id);
    }
  } catch (err) {
    console.warn(
      "[agent:worker] resume sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Graceful shutdown:
 *  1. Stop the resume timer.
 *  2. `worker.close()` waits for active jobs to finish (per ADR-0014:
 *     "workers finish the current step (with timeout)").
 *  3. The job's finally block stops the heartbeat; in-tx commits already
 *     either landed or rolled back, so the run is consistent.
 */
export async function stopAgentWorker(): Promise<void> {
  if (_resumeTimer) {
    clearInterval(_resumeTimer);
    _resumeTimer = undefined;
  }
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}
