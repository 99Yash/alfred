import { toMessage, type AgentTranscriptMessage } from "@alfred/contracts";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { z } from "zod";

import { createRedisConnection, isQueueEnabled } from "../../../queue/connection";
import {
  markConversationCompactionRequested,
  recordConversationCompactionFailure,
  type ChatSummaryWatermark,
} from "./chat-context-store";
import { compactConversationSynchronously } from "./synchronous-conversation-compaction";

export const CONVERSATION_COMPACTION_QUEUE_NAME = "conversation-compaction";

const jobDataSchema = z.object({
  kind: z.literal("conversation.compact"),
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
      providerOptions: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
type ConversationCompactionJobData = z.infer<typeof jobDataSchema>;
type ExistingJobState = "active" | "waiting" | "delayed" | string;

export interface ConversationCompactionQueueDependencies {
  enabled?: () => boolean;
  getExisting?: (
    jobId: string,
  ) => Promise<{ state: ExistingJobState; remove: () => Promise<void> } | undefined>;
  markRequested?: typeof markConversationCompactionRequested;
  add?: (jobId: string, data: ConversationCompactionJobData) => Promise<void>;
  recordFailure?: typeof recordConversationCompactionFailure;
}

let queue: Queue<ConversationCompactionJobData> | undefined;
let worker: Worker<ConversationCompactionJobData> | undefined;

export function conversationCompactionJobId(threadId: string): string {
  return `conversation-compact.${threadId}`.replaceAll(":", ".");
}

export function getConversationCompactionQueue(): Queue<ConversationCompactionJobData> {
  if (queue) return queue;
  queue = new Queue(CONVERSATION_COMPACTION_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
    },
  });
  return queue;
}

export async function enqueueConversationCompaction(
  args: {
    userId: string;
    threadId: string;
    throughWatermark: ChatSummaryWatermark;
    replayTail: readonly AgentTranscriptMessage[];
    replayTailWatermark: ChatSummaryWatermark;
  },
  dependencies: ConversationCompactionQueueDependencies = {},
): Promise<"scheduled" | "deduplicated" | "disabled"> {
  const enabled = dependencies.enabled ?? isQueueEnabled;
  if (!enabled()) return "disabled";
  const jobId = conversationCompactionJobId(args.threadId);
  const existing = dependencies.getExisting
    ? await dependencies.getExisting(jobId)
    : await getConversationCompactionQueue()
        .getJob(jobId)
        .then(async (job) =>
          job ? { state: await job.getState(), remove: () => job.remove() } : undefined,
        );
  if (existing) {
    const state = existing.state;
    if (state === "active" || state === "waiting" || state === "delayed") return "deduplicated";
    await existing.remove();
  }

  const markRequested = dependencies.markRequested ?? markConversationCompactionRequested;
  const request = await markRequested(args.userId, args.threadId);
  const data: ConversationCompactionJobData = {
    kind: "conversation.compact",
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
    if (dependencies.add) await dependencies.add(jobId, data);
    else await getConversationCompactionQueue().add("conversation.compact", data, { jobId });
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

export async function startConversationCompactionWorker(): Promise<void> {
  if (!isQueueEnabled() || worker) return;
  worker = new Worker(CONVERSATION_COMPACTION_QUEUE_NAME, processConversationCompactionJob, {
    connection: createRedisConnection(),
    concurrency: 1,
  });
  worker.on("error", (error) =>
    console.error("[conversation-compaction] worker error:", error.message),
  );
}

export async function stopConversationCompactionWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = undefined;
}

export async function closeConversationCompactionQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = undefined;
}

async function processConversationCompactionJob(
  job: Job<ConversationCompactionJobData>,
): Promise<unknown> {
  const data = jobDataSchema.parse(job.data);
  const requestedAt = new Date(data.requestedAt);
  try {
    return await compactConversationSynchronously({
      userId: data.userId,
      threadId: data.threadId,
      throughWatermark: {
        messageId: data.throughMessageId,
        createdAt: new Date(data.throughCreatedAt),
      },
      replayTail: data.replayTail,
      replayTailWatermark: {
        messageId: data.replayTailThroughMessageId,
        createdAt: new Date(data.replayTailThroughCreatedAt),
      },
      attribution: { userId: data.userId, name: "chat.conversation-summary.background" },
    });
  } catch (error) {
    await recordConversationCompactionFailure({
      userId: data.userId,
      threadId: data.threadId,
      expectedGeneration: data.expectedGeneration,
      expectedRequestedAt: requestedAt,
      category: "background_failed",
      message: toMessage(error),
    });
    if (isUnrecoverableConversationCompactionError(error)) {
      throw new UnrecoverableError(toMessage(error));
    }
    throw error;
  }
}

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
