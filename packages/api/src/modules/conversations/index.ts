// Public seam for the `conversations` module. It owns the chat HTTP surface,
// turn admission (`startTurn`), stop behavior (`stopTurn`), the chat recipe
// (`chatTurnWorkflow`), chat context assembly + summaries + compaction
// (`./compaction`), and the end-of-thread idle-capture trigger
// (`./idle-capture-queue`). Execution never imports this module; the recipe is
// registered with execution via `registerRecipe` at boot (ADR-0089).
export { chatRoutes, startTurn, stopTurn } from "./routes";
export { chatTurnWorkflow, CHAT_TURN_WORKFLOW_SLUG } from "./chat-turn";
// Chat compaction lifecycle + the reads composition (`backend.ts`) re-exports.
export {
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  closeConversationCompactionQueue,
  scheduleConversationCompactionIfNeeded,
  startConversationCompactionWorker,
  stopConversationCompactionWorker,
} from "./compaction";
// End-of-thread idle-capture trigger (was `chat-memory/queue`). Composition
// re-exports this full surface so `apps/server` and the backfill stay unchanged.
export {
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
  type ChatMemoryJobData,
} from "./idle-capture-queue";
