import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "@alfred/db/redis";
import { snapshotScratchToPostgres } from "./scratchpad/index";
import { runOnce, skipReasonIsLoud } from "./executor";
import { AGENT_QUEUE_NAME, enqueueRun, type AgentJobData } from "./queue";
import {
  findResumableRunIds,
  heartbeatRun,
  signalParentOfSubAgent,
  STALE_RUN_LEASE_MS,
} from "./service";
import { toMessage, unrefTimer } from "@alfred/contracts";

/** Keep it well below `STALE_RUN_LEASE_MS`, so one missed beat does not cause a reclaim. */
const HEARTBEAT_INTERVAL_MS = 10_000;

const RESUME_SWEEP_INTERVAL_MS = 30_000;

let _worker: Worker<AgentJobData> | undefined;

let _resumeTimer: ReturnType<typeof setInterval> | undefined;

export interface StartAgentWorkerOpts {
  /**
   * Steps mostly wait on I/O, so the DB pool sets the limit, not the CPU.
   * Required, so the value comes only from `AGENT_WORKER_CONCURRENCY`, the one the pool was sized
   * for.
   */
  concurrency: number;
}

export async function startAgentWorker(opts: StartAgentWorkerOpts): Promise<void> {
  if (_worker) return;
  const { concurrency } = opts;

  _worker = new Worker<AgentJobData>(AGENT_QUEUE_NAME, processAgentJob, {
    connection: createRedisConnection("queue"),
    concurrency,
    // Catches a dead process sooner than the resume sweep.
    stalledInterval: 30_000,
    maxStalledCount: 1,
  });

  _worker.on("error", (err) => {
    console.error("[agent:worker] error:", err.message);
  });

  // Pick up runs a previous deploy left mid-flight.
  await resumeSweep();

  _resumeTimer = setInterval(() => {
    void resumeSweep();
  }, RESUME_SWEEP_INTERVAL_MS);

  unrefTimer(_resumeTimer);
}

async function processAgentJob(job: Job<AgentJobData>): Promise<void> {
  const { runId } = job.data;
  // Log each missed beat: enough of them cause a reclaim and a second paid model call.
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

        unrefTimer(heartbeat);
      },
    });

    if (outcome.kind === "advanced") {
      await enqueueRun(runId);
    }

    if (outcome.kind === "deferred") {
      await enqueueRun(runId, { delayMs: Math.max(0, outcome.retryAt.getTime() - Date.now()) });
    }

    if (outcome.kind === "skipped" && skipReasonIsLoud(outcome.reason)) {
      console.warn(`[agent:worker] run ${runId} commit skipped: ${outcome.reason}`);
    }

    // Snapshot scratch so it outlives the Redis TTL (ADR-0036). Children write to the parent's
    // zone,
    // so a child's snapshot is empty. Failed runs too: that is when you want the scratch (#372).
    if (outcome.kind === "completed" || outcome.kind === "failed" || outcome.kind === "blocked") {
      try {
        await snapshotScratchToPostgres(runId);
      } catch (err) {
        console.warn("[agent:worker] scratchpad snapshot failed for", runId, toMessage(err));
      }
    }

    // Wake a parent waiting on this child (ADR-0073). A no-op for other runs.
    if (outcome.kind === "completed" || outcome.kind === "failed" || outcome.kind === "blocked") {
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

/** Waits for active steps to finish (ADR-0014). */
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
