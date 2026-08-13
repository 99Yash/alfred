/**
 * Two runtime adapter lifecycles, for tests that must register one adapter without
 * starting a whole runtime.
 *
 * This is a transitional door, not a second public interface. API workflow tests
 * use it because they also import `@alfred/http`, which assistant does not declare.
 * Operational smokes use it when they need one product adapter without starting
 * every worker.
 *
 * Production code never imports it — a process gets these registrations from
 * `createAssistantRuntime`, in order.
 */
export { registerTriggerConsumers, unregisterTriggerConsumers } from "./adapters/trigger-consumers";
export {
  registerWorkflowReadiness,
  unregisterWorkflowReadiness,
} from "./adapters/workflow-readiness";
export {
  registerSystemToolProductAdapters,
  unregisterSystemToolProductAdapters,
} from "./adapters/system-tool-product";
