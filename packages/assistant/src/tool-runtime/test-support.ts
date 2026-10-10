import {
  clearToolRuntimeCacheForTests,
  registerToolsRuntimeAdapter,
} from "@alfred/assistant/tool-runtime/surface-adapter";
import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";

export { _setIntegrationAvailabilityReaderForTests } from "./internal/dispatch/index";

/** Reset the registry and the runtime cache for a test. */
export function resetToolFixtures(): void {
  clearToolRegistryForTests();
  clearToolRuntimeCacheForTests();
  registerToolsRuntimeAdapter();
}
