/**
 * Dead-man timer for a parked parent (ADR-0073), worker side. It signals the parent
 * the same way a finished child does. If the parent already woke, the signal no-ops.
 */

import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "@alfred/db/redis";
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
      connection: createRedisConnection("queue"),
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
    // Rethrow so BullMQ retries. This job is the only backstop for a stranded parent.
    console.warn(
      "[sub-agent-join:wake-worker] wake failed for",
      childRunId,
      toMessage(err),
      "— will retry",
    );
    throw err;
  }
}
