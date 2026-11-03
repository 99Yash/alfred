import { chatMemoryCaptureEnabled } from "@alfred/env/server";
import { toMessage } from "@alfred/contracts";
import { z } from "zod";
import { isQueueEnabled } from "@alfred/db/redis";
import { defineQueue, job } from "@alfred/assistant/queue-jobs";
import { logger } from "@alfred/logging";

/**
 * Per-thread idle debounce for chat memory capture (#398, D9). Each finished turn
 * pushes the job out, so it fires only after the thread has been quiet for
 * `CHAT_MEMORY_IDLE_MS`. On fire it starts a `chat-memory-capture` agent run. The worker is
 * `idle-capture-worker.ts`.
 */

/** `__`-prefixed so the workflow seeder skips it: not a user-toggleable workflow. */
export const CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG = "__chat-memory-capture__";

/** `agent_runs.metadata` on a memory-capture run. The worker is the only writer. */
export const chatMemoryCaptureRunMetadataSchema = z.looseObject({
  threadId: z.string().min(1),
  /** The assistant message that armed the capture; the dedup key carries it. */
  captureAfterMessageId: z.string().min(1),
  reason: z.literal("idle-debounce"),
});

/** Provisional; D9 asks for 10 to 15 minutes. */
export const CHAT_MEMORY_IDLE_MS = 12 * 60_000;

const idleJobSlotSchema = z.enum(["primary", "tail"]);

/**
 * A stable id per thread and slot, so a reschedule replaces one job. The tail slot is used only
 * while the primary job is active, so a new turn still gets a later pass. BullMQ custom ids
 * cannot contain `:`.
 */
export function chatMemoryIdleJobId(
  threadId: string,
  slot: z.infer<typeof idleJobSlotSchema>,
): string {
  return slot === "tail" ? `chat-mem-idle-tail.${threadId}` : `chat-mem-idle.${threadId}`;
}

export const chatMemoryQueue = defineQueue({
  name: "chat-memory",
  jobs: {
    "chat-memory.extract": job(
      z.object({
        userId: z.string().min(1),
        threadId: z.string().min(1),
        captureAfterMessageId: z.string().min(1),
        /** Which of the two per-thread job ids the job holds. A job added before this field is `primary`. */
        slot: idleJobSlotSchema.default("primary"),
      }),
      ({ threadId, slot }) => ({
        delay: CHAT_MEMORY_IDLE_MS,
        jobId: chatMemoryIdleJobId(threadId, slot),
      }),
    ),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 50, age: 24 * 60 * 60 },
    removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
  },
});

async function removeReplaceableJob(
  jobId: string,
): Promise<"missing" | "active" | "removed" | "locked"> {
  const existing = await chatMemoryQueue.getJob(jobId);

  if (!existing) return "missing";
  const state = await existing.getState();

  if (state === "active") return "active";

  try {
    await existing.remove();

    return "removed";
  } catch (err) {
    const message = toMessage(err).toLowerCase();

    if (message.includes("locked") || message.includes("could not be removed")) return "locked";
    throw err;
  }
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
    const primaryState = await removeReplaceableJob(chatMemoryIdleJobId(args.threadId, "primary"));

    if (primaryState === "active" || primaryState === "locked") {
      await removeReplaceableJob(chatMemoryIdleJobId(args.threadId, "tail"));
      await chatMemoryQueue.add("chat-memory.extract", { ...args, slot: "tail" });

      return "scheduled";
    }

    await removeReplaceableJob(chatMemoryIdleJobId(args.threadId, "tail"));
    await chatMemoryQueue.add("chat-memory.extract", { ...args, slot: "primary" });

    return "scheduled";
  } catch (err) {
    logger.warn({ err, threadId: args.threadId }, "[chat-memory] failed to arm idle extraction");

    return "failed";
  }
}
