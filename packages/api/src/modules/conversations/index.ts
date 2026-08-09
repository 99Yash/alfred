// Transitional barrel: re-exports domain logic from @alfred/assistant/conversations.
// Routes stay here and import from this barrel.
// @alfred/api/backend surface is unchanged (byte-identical re-exports).

export {
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  chatMemoryCaptureWorkflow,
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  CHAT_MEMORY_IDLE_MS,
  CHAT_MEMORY_QUEUE_NAME,
  chatMemoryIdleJobId,
  chatMemoryIdleTailJobId,
  chatMemoryJobDataSchema,
  chatTurnWorkflow,
  CHAT_TURN_WORKFLOW_SLUG,
  closeConversationCompactionQueue,
  closeChatMemoryQueue,
  getChatMemoryQueue,
  scheduleConversationCompactionIfNeeded,
  scheduleThreadIdleExtraction,
  startConversationCompactionWorker,
  startChatMemoryWorker,
  stopConversationCompactionWorker,
  stopChatMemoryWorker,
  type ChatMemoryJobData,
} from "@alfred/assistant/conversations";

export { chatRoutes, startTurn, stopTurn } from "./routes";
