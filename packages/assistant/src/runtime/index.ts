/**
 * The process-facing door of the assistant.
 *
 * A host process (`apps/server`) constructs one runtime and drives two methods. It
 * keeps what only a process can own — fatal handling, the HTTP listener, the
 * environment read, authentication hooks — and passes the rest as configuration.
 *
 * Everything else this subtree holds is private: the runtime adapters, the queues,
 * and the workers get no manifest key, so no ordinary caller can name a
 * registration or a stop function and no caller can reorder the lifecycle.
 * `./runtime/test-support` is the one narrow exception, and it exists only for the
 * two `@alfred/api` suites that cannot move into this package yet.
 */
export {
  createAssistantRuntime,
  type AssistantRuntime,
  type RuntimeConfig,
  type RuntimeUserCreatedHandler,
} from "./runtime";
