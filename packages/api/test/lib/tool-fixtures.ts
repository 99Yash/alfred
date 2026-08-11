import {
  clearToolRuntimeCacheForTests,
  registerToolsRuntimeAdapter,
} from "../../src/modules/tools/tool-runtime-adapter";
import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";

/** One lifecycle door for tests that project registered tools through the tool runtime. */
export function resetToolFixtures(): void {
  clearToolRegistryForTests();
  clearToolRuntimeCacheForTests();
  registerToolsRuntimeAdapter();
}
