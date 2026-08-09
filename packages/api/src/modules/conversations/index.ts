// Transitional barrel: re-exports conversations domain logic from @alfred/assistant/conversations
// and routes from ./routes for backward compatibility during the 6B migration.
// This keeps @alfred/api/backend surface byte-identical while moving the domain module.
export {
  chatTurnWorkflow,
  CHAT_TURN_WORKFLOW_SLUG,
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  closeConversationCompactionQueue,
  scheduleConversationCompactionIfNeeded,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  CHAT_MEMORY_IDLE_MS,
  CHAT_MEMORY_QUEUE_NAME,
  chatMemoryIdleJobId,
  chatMemoryIdleTailJobId,
  chatMemoryJobDataSchema,
  closeChatMemoryQueue,
  getChatMemoryQueue,
  scheduleThreadIdleExtraction,
  startChatMemoryWorker,
  stopChatMemoryWorker,
  stopTurn,
  type ExistingChatTurnRun,
  type ChatMemoryJobData,
} from "@alfred/assistant/conversations";

// HTTP transport: startTurn is exported from routes (stays in api)
export { chatRoutes, startTurn } from "./routes";
