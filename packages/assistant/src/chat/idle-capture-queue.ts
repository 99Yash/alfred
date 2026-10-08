import { chatMemoryCaptureEnabled } from "@alfred/env/server";
import { toMessage } from "@alfred/contracts";
import { Queue, Worker, type Job } from "bullmq";
import { z } from "zod";
import { createRedisConnection, isQueueEnabled } from "@alfred/db/redis";
import { startRun } from "@alfred/assistant/execution";
import { isUniqueViolation } from "@alfred/db/pg-errors";

/**
 * Per-thread idle debounce for chat memory capture (#398, D9). Each finished turn
 * pushes the job out, so it fires only after the thread has been quiet for
 * `CHAT_MEMORY_IDLE_MS`. On fire it starts a `chat-memory-capture` agent run.
 */
export const CHAT_MEMORY_QUEUE_NAME = "chat-memory";

/** `__`-prefixed so the workflow seeder skips it: not a user-toggleable workflow. */
export const CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG = "__chat-memory-capture__";

/** Provisional; D9 asks for 10 to 15 minutes. */
export const CHAT_MEMORY_IDLE_MS = 12 * 60_000;

export const chatMemoryJobDataSchema = z.object({
  kind: z.literal("chat-memory.extract"),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  captureAfterMessageId: z.string().min(1),
});

export type ChatMemoryJobData = z.infer<typeof chatMemoryJobDataSchema>;

let _queue: Queue<ChatMemoryJobData> | undefined;

let _worker: Worker<ChatMemoryJobData> | undefined;

/** A stable id, so a reschedule replaces one job. BullMQ custom ids cannot contain `:`. */
export function chatMemoryIdleJobId(threadId: string): string {
  return `chat-mem-idle.${threadId}`;
}

/** Used only while the primary job is active, so a new turn still gets a later pass. */
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
    connection: createRedisConnection("queue"),
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
 * Re-arm the thread's idle timer. If the primary job is running, replace the tail job
 * instead. Never throws: this must not fail a chat turn.
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
    connection: createRedisConnection("queue"),
    // Cheap: the real work runs in the agent run.
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
    const started = await startRun({
      userId: data.userId,
      workflowSlug: CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
      brief: "end-of-thread memory capture over an idle chat thread",
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: `${data.threadId}:${data.captureAfterMessageId}`,
      },
      metadata: {
        threadId: data.threadId,
        captureAfterMessageId: data.captureAfterMessageId,
        reason: "idle-debounce",
      },
    });

    runId = started.runId;
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log(
        `[chat-memory:worker] deduplicated chat-memory.extract thread=${data.threadId} captureAfterMessageId=${data.captureAfterMessageId}`,
      );

      return { deduplicated: true };
    }

    throw err;
  }

  console.log(`[chat-memory:worker] chat-memory.extract thread=${data.threadId} runId=${runId}`);

  return { runId };
}
