import {
  clearToolRuntimeCacheForTests,
  registerToolsRuntimeAdapter,
} from "@alfred/assistant/tool-runtime/surface-adapter";
import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";

/** One lifecycle door for tests that project registered tools through the tool runtime. */
export function resetToolFixtures(): void {
  clearToolRegistryForTests();
  clearToolRuntimeCacheForTests();
  registerToolsRuntimeAdapter();
}
