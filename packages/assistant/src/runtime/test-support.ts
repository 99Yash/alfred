/**
 * Two runtime adapter lifecycles, for tests that must register one adapter without
 * starting a whole runtime.
 *
 * This is a transitional door, not a second public interface. Its two consumers are
 * `packages/api/test/workflows/{revisions,event-run-concurrency}.test.ts`, which
 * exercise the workflow readiness check and the workflow event trigger against a
 * live database while still importing api-owned modules (`src/modules/tools/runtime`,
 * `src/backend`) and `@alfred/http`. `@alfred/assistant` declares neither package, so
 * those suites cannot move here with the other nine. Campaign item 148 moves the
 * api-owned halves; this file goes with the last consumer.
 *
 * Production code never imports it — a process gets these registrations from
 * `createAssistantRuntime`, in order.
 */
export { registerTriggerConsumers, unregisterTriggerConsumers } from "./adapters/trigger-consumers";
export {
  registerWorkflowReadiness,
  unregisterWorkflowReadiness,
} from "./adapters/workflow-readiness";
