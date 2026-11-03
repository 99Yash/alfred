import { parseStoredTranscript } from "@alfred/ai";
import { toMessage } from "@alfred/contracts";
import { UnrecoverableError } from "bullmq";

import { isQueueEnabled } from "@alfred/db/redis";
import { recordConversationCompactionFailure } from "./chat-context-store";
import {
  conversationCompactionQueue,
  isUnrecoverableConversationCompactionError,
} from "./conversation-compaction-queue";
import { compactConversationSynchronously } from "./synchronous-conversation-compaction";

/** The `conversation-compaction` worker. Off when Redis is not configured. */
export const conversationCompactionWorker = conversationCompactionQueue.consume({
  label: "conversation-compaction",
  concurrency: 1,
  enabled: isQueueEnabled,
  handlers: {
    "conversation.compact": async (data) => {
      const requestedAt = new Date(data.requestedAt);

      try {
        return await compactConversationSynchronously({
          userId: data.userId,
          threadId: data.threadId,
          throughWatermark: {
            messageId: data.throughMessageId,
            createdAt: new Date(data.throughCreatedAt),
          },
          replayTail: parseStoredTranscript(data.replayTail),
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
    },
  },
});
