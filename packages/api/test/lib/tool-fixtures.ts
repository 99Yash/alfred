import {
  clearToolRuntimeCacheForTests,
  registerToolsRuntimeAdapter,
} from "../../src/modules/tools/tool-runtime-adapter";
import { clearToolRegistryForTests } from "../../src/modules/tools/registry";

/** One lifecycle door for tests that project registered tools through the tool runtime. */
export function resetToolFixtures(): void {
  clearToolRegistryForTests();
  clearToolRuntimeCacheForTests();
  registerToolsRuntimeAdapter();
}
