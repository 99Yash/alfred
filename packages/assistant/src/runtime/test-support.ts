/**
 * Single adapter lifecycles for tests and operational smokes that must not
 * start a whole runtime. Production code never imports this.
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
