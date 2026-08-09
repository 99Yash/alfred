// Public seam for the `conversations` module. It owns the chat HTTP surface,
// turn admission (`startTurn`), stop behavior (`stopTurn`), the chat recipe
// (`chatTurnWorkflow`), chat context assembly + summaries + compaction
// (`./compaction`), and the end-of-thread idle-capture trigger
// (`./idle-capture-queue`). Execution never imports this module; the recipe is
// registered with execution via `registerRecipe` at boot (ADR-0089).

// Re-export from routes (staying in api) — routes imports domain logic from this module
export { stopTurn, type ExistingChatTurnRun } from "./turn-stop";
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

// End-of-thread chat -> memory capture recipe; registered by the composition root.
export { chatMemoryCaptureWorkflow } from "./chat-memory-capture";

// Note: startTurn is exported from the routes file (api/modules/conversations/routes.ts)
// which imports domain logic from this module. The interface is accessible via
// @alfred/api/backend re-export of the routes barrel.
