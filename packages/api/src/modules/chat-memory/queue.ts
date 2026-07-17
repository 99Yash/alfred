import { chatMemoryCaptureEnabled } from "@alfred/env/server";
import { toMessage } from "@alfred/contracts";
import { Queue, Worker, type Job } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "../../queue/connection";
import { createRun, enqueueRun } from "../agent/index";
import { isUniqueViolation } from "../../lib/pg-errors";

/**
 * Chat → memory idle-debounce trigger (chat-memory-capture-v1.md, #398; D9).
 *
 * A per-thread dead-man timer: every finished chat turn (re)arms a delayed job
 * keyed by the thread. Each new turn pushes the timer out, so the job only
 * fires once the thread has been idle for `CHAT_MEMORY_IDLE_MS` — meaning the
 * whole conversation (and any correction arc) has settled before extraction
 * reads it. On fire, the worker fans out into a `chat-memory-capture` agent run
 * exactly the way the daily memory-cron fans into `memory-extraction`
 * (`../memory/queue.ts`) — reusing the agent executor rather than doing the
 * work inline.
 *
 * Its own lane (not the daily memory-cron queue): the access pattern is many
 * short-lived, per-thread, resettable delayed jobs, which is the
 * delayed-job-with-custom-jobId shape the sub-agent join-wake queue already
 * uses (`../agent/sub-agent-join-wake-queue.ts`), not the handful of
 * repeatables memory-cron holds.
 */
export const CHAT_MEMORY_QUEUE_NAME = "chat-memory";

/**
 * Slug of the agent workflow the debounce fans out into (defined in
 * `apps/server/src/builtins/workflows/chat-memory-capture.ts`). Internal
 * (`__`-prefixed, like `__chat-turn__`) so the workflow seeder skips it: it is a
 * debounce-driven pipeline, not a user-toggleable workflow, and the worker
 * calls `createRun` on it directly. Lives here (packages/api) rather than beside
 * the workflow because the queue can't import from `apps/server`.
 */
export const CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG = "__chat-memory-capture__";

/**
 * Idle window before a thread is extracted (D9: ~10–15 min). 12 min sits in the
 * middle; a provisional default the plan flags as tunable from real data.
 */
export const CHAT_MEMORY_IDLE_MS = 12 * 60_000;

/** The one job kind this queue carries: extract a specific idle thread. */
export const chatMemoryJobDataSchema = z.object({
  kind: z.literal("chat-memory.extract"),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  captureAfterMessageId: z.string().min(1),
});
export type ChatMemoryJobData = z.infer<typeof chatMemoryJobDataSchema>;

let _queue: Queue<ChatMemoryJobData> | undefined;
let _worker: Worker<ChatMemoryJobData> | undefined;

/**
 * Per-thread primary debounce job id. BullMQ custom job ids can't contain `:`,
 * so mirror the logical `chat-memory-idle:<threadId>` with dot separators.
 * This stable id lets the scheduler replace exactly one pending job instead of
 * scanning the whole queue on every completed chat turn.
 */
export function chatMemoryIdleJobId(threadId: string): string {
  return `chat-mem-idle.${threadId}`;
}

/**
 * Secondary job used only when the primary job is already active. A new user
 * turn during that tiny fire window must schedule one more idle pass after the
 * new turn settles; keeping a separate stable tail id gives us "latest wins"
 * without pulling an active job out from under its worker.
 */
export function chatMemoryIdleTailJobId(threadId: string): string {
  return `chat-mem-idle-tail.${threadId}`;
}

async function removeReplaceableJob(
  queue: Queue<ChatMemoryJobData>,
  jobId: string,
): Promise<"missing" | "active" | "removed" | "locked"> {
  const job = await queue.getJob(jobId);
  if (!job) return "missing";
  const state = await job.getState();
  if (state === "active") return "active";
  try {
    await job.remove();
    return "removed";
  } catch (err) {
    const message = toMessage(err).toLowerCase();
    if (message.includes("locked") || message.includes("could not be removed")) return "locked";
    throw err;
  }
}

async function addIdleJob(
  queue: Queue<ChatMemoryJobData>,
  args: {
    userId: string;
    threadId: string;
    captureAfterMessageId: string;
    jobId: string;
  },
): Promise<void> {
  await queue.add(
    "chat-memory.extract",
    {
      kind: "chat-memory.extract",
      userId: args.userId,
      threadId: args.threadId,
      captureAfterMessageId: args.captureAfterMessageId,
    } satisfies ChatMemoryJobData,
    {
      delay: CHAT_MEMORY_IDLE_MS,
      jobId: args.jobId,
    },
  );
}

export function getChatMemoryQueue(): Queue<ChatMemoryJobData> {
  if (_queue) return _queue;
  _queue = new Queue<ChatMemoryJobData>(CHAT_MEMORY_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 50, age: 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
    },
  });
  return _queue;
}

/**
 * (Re)arm the idle timer for a thread — the debounce reset. Replaces the exact
 * per-thread primary delayed job and schedules it at `CHAT_MEMORY_IDLE_MS`, so
 * each new completed assistant turn pushes extraction further out. If the
 * primary job is already active (mid-fire), we leave it alone and replace the
 * per-thread tail job instead; that closes the race where a user sends a new
 * turn while the prior idle fire is already running. Best-effort: never throws
 * into the caller (arming memory capture must not fail a chat turn), mirroring
 * the join-wake scheduler.
 */
export async function scheduleThreadIdleExtraction(args: {
  userId: string;
  threadId: string;
  captureAfterMessageId: string;
}): Promise<"scheduled" | "disabled" | "failed"> {
  if (!isQueueEnabled() || !chatMemoryCaptureEnabled()) return "disabled";
  try {
    const queue = getChatMemoryQueue();
    const primaryJobId = chatMemoryIdleJobId(args.threadId);
    const tailJobId = chatMemoryIdleTailJobId(args.threadId);
    const primaryState = await removeReplaceableJob(queue, primaryJobId);
    if (primaryState === "active" || primaryState === "locked") {
      await removeReplaceableJob(queue, tailJobId);
      await addIdleJob(queue, { ...args, jobId: tailJobId });
      return "scheduled";
    }
    await removeReplaceableJob(queue, tailJobId);
    await addIdleJob(queue, { ...args, jobId: primaryJobId });
    return "scheduled";
  } catch (err) {
    console.warn("[chat-memory] failed to arm idle extraction", args.threadId, toMessage(err));
    return "failed";
  }
}

export interface StartChatMemoryWorkerOpts {
  concurrency?: number;
}

export async function startChatMemoryWorker(opts: StartChatMemoryWorkerOpts = {}): Promise<void> {
  if (!chatMemoryCaptureEnabled()) return;
  if (_worker) return;
  _worker = new Worker<ChatMemoryJobData>(CHAT_MEMORY_QUEUE_NAME, processChatMemoryJob, {
    connection: createRedisConnection(),
    // Cheap (a couple of queries + an enqueue); the real work runs in the
    // fanned-out agent run, so single-threaded is plenty.
    concurrency: opts.concurrency ?? 1,
  });
  _worker.on("error", (err) => {
    console.error("[chat-memory:worker] error:", err.message);
  });
}

export async function stopChatMemoryWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}

export async function closeChatMemoryQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}

async function processChatMemoryJob(job: Job<ChatMemoryJobData>): Promise<unknown> {
  const data = chatMemoryJobDataSchema.parse(job.data);
  let runId: string;
  try {
    const created = await createRun({
      userId: data.userId,
      workflowSlug: CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
      brief: "end-of-thread memory capture over an idle chat thread",
      // The debounce fire is neither a cron nor a user action; `manual` matches
      // the ad-hoc `enqueueExtractionForUser` precedent. The thread/message
      // anchor is carried in metadata (as the chat-turn workflow does), where the
      // workflow reads it.
      trigger: { kind: "manual" },
      metadata: {
        threadId: data.threadId,
        captureAfterMessageId: data.captureAfterMessageId,
        reason: "idle-debounce",
      },
    });
    runId = created.runId;
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log(
        `[chat-memory:worker] deduplicated chat-memory.extract thread=${data.threadId} captureAfterMessageId=${data.captureAfterMessageId}`,
      );
      return { deduplicated: true };
    }
    throw err;
  }
  await enqueueRun(runId);
  console.log(`[chat-memory:worker] chat-memory.extract thread=${data.threadId} runId=${runId}`);
  return { runId };
}
