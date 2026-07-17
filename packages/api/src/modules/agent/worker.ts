import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../../queue/connection";
import { snapshotScratchToPostgres } from "../scratchpad";
import { runOnce } from "./executor";
import { AGENT_QUEUE_NAME, enqueueRun, type AgentJobData } from "./queue";
import {
  findResumableRunIds,
  heartbeatRun,
  signalParentOfSubAgent,
  STALE_RUN_LEASE_MS,
} from "./service";
import { toMessage } from "@alfred/contracts";

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
  // A heartbeat bumps `last_checkpoint_at` so the resume sweep doesn't reclaim a
  // live run mid-step. A sustained gap (≥ STALE_RUN_LEASE_MS) lets a still-alive
  // worker be reclaimed → a duplicate, full-price model call on the slowest
  // turns. Swallowing the error silently (the old `.catch(() => {})`) hid that
  // drift entirely; log each miss with a count so an approaching reclaim is
  // visible in the logs instead of only showing up as a surprise double-spend.
  let missedHeartbeats = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    const outcome = await runOnce(runId, {
      onLeased: ({ attempt }) => {
        heartbeat = setInterval(() => {
          void heartbeatRun(runId, attempt)
            .then((refreshed) => {
              if (!refreshed) {
                console.warn(
                  `[agent:worker] heartbeat no-op for run ${runId} attempt ${attempt}; lease was superseded or run is no longer running`,
                );
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = undefined;
                return;
              }
              missedHeartbeats = 0;
            })
            .catch((err) => {
              missedHeartbeats += 1;
              console.warn(
                `[agent:worker] heartbeat miss #${missedHeartbeats} for run ${runId} attempt ${attempt} (~${missedHeartbeats * (HEARTBEAT_INTERVAL_MS / 1000)}s without checkpoint; reclaim after the step's stale window, default ${STALE_RUN_LEASE_MS / 1000}s — longer for model-turn steps):`,
                toMessage(err),
              );
            });
        }, HEARTBEAT_INTERVAL_MS);
        if (typeof heartbeat === "object" && "unref" in heartbeat) {
          heartbeat.unref();
        }
      },
    });
    // If the run advanced, immediately re-enqueue so the next step picks
    // up without waiting for a sweep — keeps short workflows snappy.
    if (outcome.kind === "advanced") {
      await enqueueRun(runId);
    }
    // Terminal-step scratchpad snapshot (ADR-0036): when a run reaches a
    // terminal state, persist its Redis scratchpad into `agent_run_context` so
    // the durable record survives the 30-day key TTL. Keyed by `runId` — for a
    // top-level boss run this captures both its `shared.*` promotes and any
    // sub-agent `scratch.*` writes (children write into the parent run's zone);
    // for a sub-agent child the scan is an empty no-op. Idempotent (ON CONFLICT)
    // and best-effort: a snapshot failure must not fail the run. Failed runs are
    // snapshotted too (#372): a run that dies with a turn-limit or tool error
    // still holds the working memory you most want to post-mortem, and a failed
    // run is terminal so there's no resume/double-write risk.
    if (outcome.kind === "completed" || outcome.kind === "failed") {
      try {
        await snapshotScratchToPostgres(runId);
      } catch (err) {
        console.warn("[agent:worker] scratchpad snapshot failed for", runId, toMessage(err));
      }
    }
    // ADR-0073: a sub-agent child just reached a terminal state — wake the
    // parent joining it (system.await_sub_agent) and enqueue it for an
    // immediate resume so the boss reports the real result this turn instead
    // of polling scratch and giving up (#268). Best-effort: a non-sub-agent
    // run or an already-moved-on parent is a no-op.
    if (outcome.kind === "completed" || outcome.kind === "failed") {
      try {
        const parentRunId = await signalParentOfSubAgent(runId);
        if (parentRunId) await enqueueRun(parentRunId);
      } catch (err) {
        console.warn("[agent:worker] sub-agent parent signal failed for", runId, toMessage(err));
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function resumeSweep(): Promise<void> {
  try {
    const ids = await findResumableRunIds({ limit: 50 });
    for (const id of ids) {
      await enqueueRun(id);
    }
  } catch (err) {
    console.warn("[agent:worker] resume sweep failed:", toMessage(err));
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
