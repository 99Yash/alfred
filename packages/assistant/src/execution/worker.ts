import type { BackgroundWorker, Companion } from "@alfred/assistant/queue-jobs";
import { snapshotScratchToPostgres } from "./scratchpad/index";
import { runOnce, skipReasonIsLoud } from "./executor";
import { agentQueue, enqueueRun } from "./queue";
import {
  findResumableRunIds,
  heartbeatRun,
  STALE_RUN_LEASE_MS,
  wakeParentOfSubAgent,
} from "./service";
import { unrefTimer } from "@alfred/contracts";
import { logger } from "@alfred/logging";

/** Keep it well below `STALE_RUN_LEASE_MS`, so one missed beat does not cause a reclaim. */
const HEARTBEAT_INTERVAL_MS = 10_000;

const RESUME_SWEEP_INTERVAL_MS = 30_000;

export interface AgentWorkerOpts {
  /**
   * Steps mostly wait on I/O, so the DB pool sets the limit, not the CPU.
   * Required, so the value comes only from `AGENT_WORKER_CONCURRENCY`, the one the pool was sized
   * for.
   */
  concurrency: number;
}

/**
 * The `agent-runs` worker. Both kinds run one step; `start` differs only in its job id.
 * The resume sweep starts after the worker and stops before it closes. Stopping waits for active
 * steps to finish (ADR-0014).
 */
export function agentWorker(opts: AgentWorkerOpts): BackgroundWorker {
  return agentQueue.consume({
    label: "agent",
    concurrency: opts.concurrency,
    // Catches a dead process sooner than the resume sweep.
    stall: { stalledInterval: 30_000, maxStalledCount: 1 },
    handlers: {
      step: async ({ runId }) => processAgentJob(runId),
      start: async ({ runId }) => processAgentJob(runId),
    },
    alongside: [resumeSweepLoop()],
  });
}

/** Pick up runs a previous deploy left mid-flight. The first sweep is awaited at start. */
function resumeSweepLoop(): Companion {
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    async start() {
      await resumeSweep();

      timer = setInterval(() => {
        void resumeSweep();
      }, RESUME_SWEEP_INTERVAL_MS);

      unrefTimer(timer);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

async function processAgentJob(runId: string): Promise<void> {
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
                logger.warn(
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
              logger.warn(
                { err },
                `[agent:worker] heartbeat miss #${missedHeartbeats} for run ${runId} attempt ${attempt} (~${missedHeartbeats * (HEARTBEAT_INTERVAL_MS / 1000)}s without checkpoint; reclaim after the step's stale window, default ${STALE_RUN_LEASE_MS / 1000}s — longer for model-turn steps)`,
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
      logger.warn(`[agent:worker] run ${runId} commit skipped: ${outcome.reason}`);
    }

    // Snapshot scratch so it outlives the Redis TTL (ADR-0036). Children write to the parent's
    // zone,
    // so a child's snapshot is empty. Failed runs too: that is when you want the scratch (#372).
    if (outcome.kind === "completed" || outcome.kind === "failed" || outcome.kind === "blocked") {
      try {
        await snapshotScratchToPostgres(runId);
      } catch (err) {
        logger.warn({ err, runId }, "[agent:worker] scratchpad snapshot failed");
      }
    }

    // Wake a parent waiting on this child (ADR-0073). A no-op for other runs.
    if (outcome.kind === "completed" || outcome.kind === "failed" || outcome.kind === "blocked") {
      try {
        await wakeParentOfSubAgent(runId);
      } catch (err) {
        logger.warn({ err, runId }, "[agent:worker] sub-agent parent signal failed");
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
    logger.warn({ err }, "[agent:worker] resume sweep failed");
  }
}
