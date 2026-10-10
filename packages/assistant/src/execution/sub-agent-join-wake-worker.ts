/**
 * Dead-man timer for a parked parent (ADR-0073), worker side. It signals the parent
 * the same way a finished child does. If the parent already woke, the signal no-ops.
 * The delayed job lives only in Redis, so a failed schedule or a lost job would park the parent
 * forever. A Postgres reconciler is the backstop: it wakes a `waiting` run whose signal wake
 * deadline is past, and it starts and stops with the worker.
 */

import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, asc, eq, sql } from "drizzle-orm";
import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "@alfred/db/redis";
import { enqueueRun } from "./queue";
import { signalParentOfSubAgent, signalRun } from "./service";
import {
  AWAIT_SUB_AGENT_CEILING_MS,
  SUB_AGENT_JOIN_WAKE_QUEUE_NAME,
  subAgentJoinWakeJobDataSchema,
  type SubAgentJoinWakeJobData,
} from "./sub-agent-join-wake-queue";
import { toMessage, wakeConditionSchema } from "@alfred/contracts";
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";

/** A lost timer wakes the parent at most this late. A join blocks a live chat turn. */
const RECONCILE_INTERVAL_MS = 60_000;

/** Rows per pass, oldest park first. */
const RECONCILE_BATCH_SIZE = 100;

let _worker: Worker<SubAgentJoinWakeJobData> | undefined;

export interface StartSubAgentJoinWakeWorkerOpts {
  concurrency?: number;
}

export async function startSubAgentJoinWakeWorker(
  opts: StartSubAgentJoinWakeWorkerOpts = {},
): Promise<void> {
  if (_worker) return;
  _worker = new Worker<SubAgentJoinWakeJobData>(
    SUB_AGENT_JOIN_WAKE_QUEUE_NAME,
    processSubAgentJoinWakeJob,
    {
      connection: createRedisConnection("queue"),
      concurrency: opts.concurrency ?? 1,
    },
  );
  _worker.on("error", (err) => {
    console.error("[sub-agent-join:wake-worker] error:", err.message);
  });
  reconciler.start();
}

export async function stopSubAgentJoinWakeWorker(): Promise<void> {
  if (!_worker) return;
  await reconciler.stop();
  await _worker.close();
  _worker = undefined;
}

interface SubAgentJoinWakeResult {
  status: "woken" | "noop";
  childRunId: string;
  parentRunId?: string;
}

async function processSubAgentJoinWakeJob(
  job: Job<SubAgentJoinWakeJobData>,
): Promise<SubAgentJoinWakeResult> {
  const { childRunId, parentRunId } = subAgentJoinWakeJobDataSchema.parse(job.data);

  try {
    const woken = await signalParentOfSubAgent(childRunId);
    // Always enqueue; a redundant enqueue is harmless. A prior attempt may have woken
    // the parent and died before enqueueing it, so `woken` is null but the parent needs a job.
    const target = woken ?? parentRunId;
    await enqueueRun(target);

    return { status: woken ? "woken" : "noop", childRunId, parentRunId };
  } catch (err) {
    // Rethrow so BullMQ retries. This job is the fast path; the reconciler below is the backstop.
    console.warn(
      "[sub-agent-join:wake-worker] wake failed for",
      childRunId,
      toMessage(err),
      "— will retry",
    );
    throw err;
  }
}

/**
 * Wake `waiting` runs whose signal wake deadline is past, and return how many woke. It matches on
 * the wake name the row holds, so a race with the live job or the child signal resolves under the
 * row lock in `signalRunInTx`. `now` comes from the app clock, the same clock that wrote the
 * deadline. A signal wake with no deadline falls back to its park time plus the sub-agent
 * ceiling: the park write is the last writer of `lastCheckpointAt` on a `waiting` row. That is
 * every such wake, not only a legacy row: `StepResult.interrupt.wake` and
 * `ToolCallDispatchResult.parked.wake` accept a raw signal wake, so a producer that skips
 * `joinChildRun` gets the sub-agent ceiling with no error. Item 29 removes the fallback.
 */
async function wakeOverdueJoinsOnce(now: Date, signal: AbortSignal): Promise<number> {
  const parked = await db()
    .select({
      id: agentRuns.id,
      wakeCondition: agentRuns.wakeCondition,
      lastCheckpointAt: agentRuns.lastCheckpointAt,
    })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.status, "waiting"), sql`${agentRuns.wakeCondition} ->> 'kind' = 'signal'`),
    )
    .orderBy(asc(agentRuns.lastCheckpointAt))
    .limit(RECONCILE_BATCH_SIZE);

  let woken = 0;

  for (const row of parked) {
    if (signal.aborted) break;

    const wake = wakeConditionSchema.safeParse(row.wakeCondition);

    if (!wake.success || wake.data.kind !== "signal") continue;

    // A row with no checkpoint is due at once, on purpose: it has no park time to wait from.
    const deadlineMs = wake.data.deadlineAt
      ? Date.parse(wake.data.deadlineAt)
      : (row.lastCheckpointAt?.getTime() ?? 0) + AWAIT_SUB_AGENT_CEILING_MS;

    if (deadlineMs > now.getTime()) continue;

    try {
      const didWake = await signalRun({
        runId: row.id,
        match: { kind: "signal", name: wake.data.name },
      });

      if (!didWake) continue;
      woken += 1;

      try {
        await enqueueRun(row.id);
      } catch (err) {
        // The resume sweep picks up a `runnable` run, so a lost enqueue only adds latency. During a
        // Redis outage the enqueue hangs instead of failing, and this pass stalls until
        // Redis returns (a follow-up moves the enqueue out of the pass).
        console.warn(
          "[sub-agent-join:wake-reconciler] failed to enqueue",
          row.id,
          toMessage(err),
          "— resume sweep will retry",
        );
      }
    } catch (err) {
      console.warn("[sub-agent-join:wake-reconciler] failed to wake", row.id, toMessage(err));
    }
  }

  return woken;
}

const reconciler = new PeriodicTask({
  name: "sub-agent-join-wake-reconciler",
  intervalMs: RECONCILE_INTERVAL_MS,
  // Run at boot too, so a timer lost in a Redis restart fires on the next start.
  runOnStart: true,
  pass: async (signal) => {
    const woken = await wakeOverdueJoinsOnce(new Date(), signal);

    // The delayed job and the deadline fire at the same instant, so a healthy park can count here.
    if (woken > 0) {
      console.warn("[sub-agent-join:wake-reconciler] woke", woken, "by the backstop");
    }
  },
});
