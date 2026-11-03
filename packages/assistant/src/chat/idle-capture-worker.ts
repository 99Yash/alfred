import { chatMemoryCaptureEnabled } from "@alfred/env/server";
import type { z } from "zod";
import { startRun } from "@alfred/assistant/execution";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { logger } from "@alfred/logging";
import {
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  chatMemoryQueue,
  type chatMemoryCaptureRunMetadataSchema,
} from "./idle-capture-queue";

type ChatMemoryCaptureRunMetadataInput = z.input<typeof chatMemoryCaptureRunMetadataSchema>;

/** The `chat-memory` worker. Off while chat memory capture is off. */
export const chatMemoryWorker = chatMemoryQueue.consume({
  label: "chat-memory",
  // Cheap: the real work runs in the agent run.
  concurrency: 1,
  enabled: chatMemoryCaptureEnabled,
  handlers: {
    "chat-memory.extract": async (data) => {
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
          } satisfies ChatMemoryCaptureRunMetadataInput,
        });

        runId = started.runId;
      } catch (err) {
        if (isUniqueViolation(err)) {
          logger.info(
            `[chat-memory:worker] deduplicated chat-memory.extract thread=${data.threadId} captureAfterMessageId=${data.captureAfterMessageId}`,
          );

          return { deduplicated: true };
        }

        throw err;
      }

      logger.info(
        `[chat-memory:worker] chat-memory.extract thread=${data.threadId} runId=${runId}`,
      );

      return { runId };
    },
  },
});
