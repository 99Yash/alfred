// Transitional barrel: re-exports domain logic from @alfred/assistant/conversations
// so that `@alfred/api/backend` keeps advertising these names while consumers move
// to the assistant package directly. The `/api/chat` transport left this directory
// at campaign item 25 and now lives in `@alfred/http`.
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
