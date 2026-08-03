import {
  clearToolCapabilitySurfaceCacheForTests,
  registerToolCapabilitySurfaceAdapter,
} from "../../src/modules/tools/capability-surface";
import { clearToolRegistryForTests } from "../../src/modules/tools/registry";

/** One lifecycle door for tests that project registered tools through capabilities. */
export function resetToolFixtures(): void {
  clearToolRegistryForTests();
  clearToolCapabilitySurfaceCacheForTests();
  registerToolCapabilitySurfaceAdapter();
}
