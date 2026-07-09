/**
 * Chat → memory capture (chat-memory-capture-v1.md, #397).
 *
 * v1 slice #398 = the idle-debounce end-of-thread TRIGGER (`./queue`) and the
 * cheap-model EXTRACTOR (`./extractor`) that distills a finished thread into
 * crisp, tagged propositions. No durable writes happen here — the observation
 * write path lands in #399.
 */

export * from "./extractor";
export {
  CHAT_MEMORY_QUEUE_NAME,
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  CHAT_MEMORY_IDLE_MS,
  chatMemoryIdleJobId,
  chatMemoryIdleTailJobId,
  getChatMemoryQueue,
  scheduleThreadIdleExtraction,
  startChatMemoryWorker,
  stopChatMemoryWorker,
  closeChatMemoryQueue,
  chatMemoryJobDataSchema,
  type ChatMemoryJobData,
  type StartChatMemoryWorkerOpts,
} from "./queue";
