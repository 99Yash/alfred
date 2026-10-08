/**
 * The process-facing door of the assistant. A host (`apps/server`) builds one
 * runtime and calls `start` and `stop`. Adapters, queues, and workers stay
 * private, so no caller can reorder the lifecycle.
 */
export {
  createAssistantRuntime,
  type AssistantRuntime,
  type RuntimeConfig,
  type RuntimeUserCreatedHandler,
} from "./runtime";
