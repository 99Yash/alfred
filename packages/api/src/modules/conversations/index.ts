// Transitional barrel. `@alfred/assistant/conversations` owns this domain logic;
// this file re-exports its names unchanged so that the `@alfred/api` doors that
// already advertise them keep doing so while consumers repoint at the assistant
// package directly. It holds no code of its own, so it is finished the day nothing
// resolves any of these names through `@alfred/api` — check that by following the
// names, not by reading a list of readers here. The `/api/chat` transport left this
// directory at campaign item 25 and now lives in `@alfred/http`.

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
