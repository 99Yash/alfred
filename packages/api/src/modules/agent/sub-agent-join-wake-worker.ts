/**
 * Sub-agent join dead-man timer (ADR-0073) — worker side.
 *
 * When a delayed `sub-agent-join-wake:<childRunId>` job fires, the parent boss
 * has been parked on the child's completion signal for `AWAIT_SUB_AGENT_-
 * CEILING_MS`. By now the child is terminal in every real case (ADR-0070's
 * backstop guarantees it), so we reuse the exact same revive path the worker
 * runs on a child's terminal transition: `signalParentOfSubAgent` fires
 * `sub_agent_done:<childRunId>`, and if the parent was still waiting on it we
 * enqueue it for an immediate resume. On resume the await re-reads the child's
 * (terminal) outcome and the boss reports a real result.
 *
 * Idempotent and best-effort: if the parent already woke on the in-band signal
 * (the common path), it is no longer `waiting`, `signalRun` no-ops, and this
 * job is a harmless tick. This is the single backstop that covers the
 * lost-wakeup race, the cancelled-child path, and a worker crash between the
 * child's terminal commit and its signal.
 *
 * Lives apart from `sub-agent-join-wake-queue.ts` because it imports the agent
 * service (`signalParentOfSubAgent`/`enqueueRun`), which sits above the
 * dispatcher in the import graph; keeping the scheduling helper agent-free lets
 * the dispatcher schedule the timer without an import cycle (mirrors the
 * approval expiry queue/worker split).
 */

import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../../queue/connection";
import { enqueueRun } from "./queue";
import { signalParentOfSubAgent } from "./service";
import {
  SUB_AGENT_JOIN_WAKE_QUEUE_NAME,
  subAgentJoinWakeJobDataSchema,
  type SubAgentJoinWakeJobData,
} from "./sub-agent-join-wake-queue";
import { toMessage } from "@alfred/contracts";

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
      connection: createRedisConnection(),
      concurrency: opts.concurrency ?? 1,
    },
  );
  _worker.on("error", (err) => {
    console.error("[sub-agent-join:wake-worker] error:", err.message);
  });
}

export async function stopSubAgentJoinWakeWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = undefined;
}

export interface SubAgentJoinWakeResult {
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
    // Always enqueue the parent so it resumes — `leaseRun` no-ops on a terminal,
    // `waiting`, or freshly-`running` row, so a redundant enqueue is harmless.
    // The case that NEEDS the job-data `parentRunId`: a prior attempt fired the
    // signal (parent → `runnable`) then died before `enqueueRun`. This retry
    // gets `woken === null` (the parent is no longer `waiting`) yet the parent
    // is still `runnable`-but-unqueued; enqueuing from job data revives it
    // instead of leaning on the slow periodic resume sweep. On the happy path
    // (in-band signal already woke and finished the parent) `woken` is null too
    // and the enqueue lands on a terminal row as a no-op.
    const target = woken ?? parentRunId;
    await enqueueRun(target);
    return { status: woken ? "woken" : "noop", childRunId, parentRunId };
  } catch (err) {
    // Rethrow so BullMQ consumes a configured retry (attempts: 3, exponential
    // backoff) instead of marking the job complete. This delayed job is the
    // ONLY backstop for a parent stranded in `waiting` (the in-band signal was
    // lost and `findResumableRunIds` never sweeps `waiting`); swallowing a
    // transient DB/Redis failure here would burn that backstop on the first
    // hiccup and leave the boss waiting forever.
    console.warn(
      "[sub-agent-join:wake-worker] wake failed for",
      childRunId,
      toMessage(err),
      "— will retry",
    );
    throw err;
  }
}
