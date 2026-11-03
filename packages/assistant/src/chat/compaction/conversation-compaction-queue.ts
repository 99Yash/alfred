import { jsonObjectSchema, toMessage, type AgentTranscriptMessage } from "@alfred/contracts";
import { z } from "zod";

import { isQueueEnabled } from "@alfred/db/redis";
import { defineQueue, job, type JobInput } from "@alfred/assistant/queue-jobs";
import {
  markConversationCompactionRequested,
  recordConversationCompactionFailure,
} from "./chat-context-store";
import type { ChatMessageWatermark } from "./chat-message-watermark";

/** BullMQ custom ids cannot contain `:`. */
function conversationCompactionJobId(threadId: string): string {
  return `conversation-compact.${threadId}`.replaceAll(":", ".");
}

/** Background compaction of one chat thread. The worker is `conversation-compaction-worker.ts`. */
export const conversationCompactionQueue = defineQueue({
  name: "conversation-compaction",
  jobs: {
    /** One job per thread: the job id is the thread. */
    "conversation.compact": job(
      z.object({
        userId: z.string().min(1),
        threadId: z.string().min(1),
        throughMessageId: z.string().min(1),
        throughCreatedAt: z.iso.datetime(),
        replayTailThroughMessageId: z.string().min(1),
        replayTailThroughCreatedAt: z.iso.datetime(),
        requestedAt: z.iso.datetime(),
        expectedGeneration: z.number().int().nonnegative(),
        replayTail: z.array(
          z.object({
            role: z.enum(["system", "user", "assistant", "tool"]),
            content: z.unknown(),
            providerOptions: jsonObjectSchema.optional(),
          }),
        ),
      }),
      ({ threadId }) => ({ jobId: conversationCompactionJobId(threadId) }),
    ),
  },
  defaults: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 100, age: 24 * 60 * 60 },
    removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
  },
});

type ConversationCompactionJobInput = JobInput<
  typeof conversationCompactionQueue,
  "conversation.compact"
>;

/** Test seam. Each default reads the queue handle or the context store. */
export interface ConversationCompactionQueueDependencies {
  enabled?: () => boolean;
  getExisting?: (
    jobId: string,
  ) => Promise<{ state: string; remove: () => Promise<void> } | undefined>;
  markRequested?: typeof markConversationCompactionRequested;
  add?: (data: ConversationCompactionJobInput) => Promise<void>;
  recordFailure?: typeof recordConversationCompactionFailure;
}

async function getExistingJob(
  jobId: string,
): Promise<{ state: string; remove: () => Promise<void> } | undefined> {
  const existing = await conversationCompactionQueue.getJob(jobId);

  return existing
    ? { state: await existing.getState(), remove: async () => existing.remove() }
    : undefined;
}

async function addJob(data: ConversationCompactionJobInput): Promise<void> {
  await conversationCompactionQueue.add("conversation.compact", data);
}

export async function enqueueConversationCompaction(
  args: {
    userId: string;
    threadId: string;
    throughWatermark: ChatMessageWatermark;
    replayTail: readonly AgentTranscriptMessage[];
    replayTailWatermark: ChatMessageWatermark;
  },
  dependencies: ConversationCompactionQueueDependencies = {},
): Promise<"scheduled" | "deduplicated" | "disabled"> {
  const enabled = dependencies.enabled ?? isQueueEnabled;

  if (!enabled()) return "disabled";
  const getExisting = dependencies.getExisting ?? getExistingJob;
  const existing = await getExisting(conversationCompactionJobId(args.threadId));

  if (existing) {
    const state = existing.state;

    if (state === "active" || state === "waiting" || state === "delayed") return "deduplicated";
    await existing.remove();
  }

  const markRequested = dependencies.markRequested ?? markConversationCompactionRequested;
  const request = await markRequested(args.userId, args.threadId);

  const data: ConversationCompactionJobInput = {
    userId: args.userId,
    threadId: args.threadId,
    throughMessageId: args.throughWatermark.messageId,
    throughCreatedAt: args.throughWatermark.createdAt.toISOString(),
    replayTailThroughMessageId: args.replayTailWatermark.messageId,
    replayTailThroughCreatedAt: args.replayTailWatermark.createdAt.toISOString(),
    requestedAt: request.requestedAt.toISOString(),
    expectedGeneration: request.generation,
    replayTail: [...args.replayTail],
  };

  try {
    const add = dependencies.add ?? addJob;
    await add(data);

    return "scheduled";
  } catch (error) {
    const recordFailure = dependencies.recordFailure ?? recordConversationCompactionFailure;
    await recordFailure({
      userId: args.userId,
      threadId: args.threadId,
      expectedGeneration: request.generation,
      expectedRequestedAt: request.requestedAt,
      category: "enqueue_failed",
      message: toMessage(error),
    });
    throw error;
  }
}

/** A deterministic evidence failure: a retry fails the same way, so the worker does not retry it. */
export function isUnrecoverableConversationCompactionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return [
    "conversation_summary_invalid_provenance",
    "conversation_summary_requires_messages",
    "conversation_summary_duplicate_source_id",
    "conversation_summary_input_too_large",
    "conversation_summary_no_new_messages",
    "conversation_summary_watermark_not_loaded",
  ].some((prefix) => error.message.startsWith(prefix));
}
