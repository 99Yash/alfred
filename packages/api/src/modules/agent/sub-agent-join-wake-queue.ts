/**
 * Sub-agent join dead-man timer (ADR-0073) — scheduling side.
 *
 * When the boss calls `system.await_sub_agent` on a still-running child, the
 * dispatcher returns `parked` and the executor commits the parent to
 * `status='waiting'` on a `sub_agent_done:<childRunId>` signal. That signal is
 * the ONLY thing that normally revives the parent — `findResumableRunIds`
 * sweeps `('pending','runnable')` and never `waiting`. So a single dropped,
 * never-fired, or too-early signal strands the boss forever. The known holes:
 *
 *  - Lost-wakeup race: the child finishes in the gap between the dispatcher
 *    reading it as running and the executor committing `waiting`; the signal
 *    fires against a not-yet-`waiting` parent and is dropped as `not_waiting`.
 *  - Cancelled child: `cancelRunInTx` nulls the wake without signalling, and
 *    the worker only signals on `completed|failed`.
 *  - Worker crash between the child's terminal commit and its signal.
 *
 * Mirroring the approval-expiry timer (`expiry-queue.ts`), every `parked`
 * schedules a delayed wake job here at `AWAIT_SUB_AGENT_CEILING_MS`. When it
 * fires, the worker re-reads the (by-then terminal) child and signals the
 * parent — collapsing all the stuck cases into one bounded fallback and making
 * the documented ceiling load-bearing instead of decorative.
 *
 * Holds ONLY the queue + scheduling helper and imports nothing from `./` agent
 * internals — the dispatcher imports it and already sits underneath the agent
 * executor. The worker side (`sub-agent-join-wake-worker.ts`) imports
 * `signalParentOfSubAgent`/`enqueueRun`, so it lives apart to avoid a cycle.
 */

import { Queue } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";
import { toMessage } from "@alfred/contracts";

export const SUB_AGENT_JOIN_WAKE_QUEUE_NAME = "sub-agent-join-wake";

export const subAgentJoinWakeJobDataSchema = z.object({
  childRunId: z.string().min(1),
  parentRunId: z.string().min(1),
});
export type SubAgentJoinWakeJobData = z.infer<typeof subAgentJoinWakeJobDataSchema>;

let _queue: Queue<SubAgentJoinWakeJobData> | undefined;

export function subAgentJoinWakeJobId(childRunId: string): string {
  // BullMQ custom job ids cannot contain `:`; mirror the logical
  // `sub-agent-join-wake:<childRunId>` id with a dot separator.
  return `sub-agent-join-wake.${childRunId}`;
}

export function getSubAgentJoinWakeQueue(): Queue<SubAgentJoinWakeJobData> {
  if (_queue) return _queue;
  _queue = new Queue<SubAgentJoinWakeJobData>(SUB_AGENT_JOIN_WAKE_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 100, age: 60 * 60 },
      removeOnFail: { count: 200, age: 24 * 60 * 60 },
    },
  });
  return _queue;
}

export async function scheduleSubAgentJoinWakeJob(args: {
  childRunId: string;
  parentRunId: string;
  delayMs: number;
}): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled()) return "disabled";
  try {
    const queue = getSubAgentJoinWakeQueue();
    const jobId = subAgentJoinWakeJobId(args.childRunId);
    // `add` no-ops when a job with this id already exists, and
    // `removeOnComplete.age` keeps a completed job for up to an hour. A
    // crash/resume re-dispatch that re-parks the same await inside that window
    // would otherwise silently skip and leave the parent without a live timer.
    // Drop any lingering terminal job first; leave a still-`delayed` job alone
    // (the bare `add` no-ops on it, which is the intended idempotency) and an
    // `active` job alone (it is mid-wake and must not be pulled out).
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        await existing.remove();
      }
    }
    await queue.add(
      "sub-agent-join.wake",
      { childRunId: args.childRunId, parentRunId: args.parentRunId },
      {
        delay: Math.max(0, args.delayMs),
        jobId,
      },
    );
    return "scheduled";
  } catch (err) {
    console.warn(
      "[sub-agent-join] failed to schedule dead-man wake",
      args.childRunId,
      toMessage(err),
    );
    return "failed";
  }
}

export async function closeSubAgentJoinWakeQueue(): Promise<void> {
  if (!_queue) return;
  await _queue.close();
  _queue = undefined;
}
