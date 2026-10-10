import type { IntegrationAvailabilitySnapshot, LoadableIntegrationSlug } from "@alfred/contracts";
import {
  clearToolRuntimeCacheForTests,
  registerToolsRuntimeAdapter,
} from "@alfred/assistant/tool-runtime/surface-adapter";
import { clearToolRegistryForTests } from "@alfred/assistant/tool-runtime";
import { _setIntegrationAvailabilityReaderForTests } from "./internal/dispatch/index";

export { _setIntegrationAvailabilityReaderForTests } from "./internal/dispatch/index";

/** Reset the registry and the runtime cache for a test. */
export function resetToolFixtures(): void {
  clearToolRegistryForTests();
  clearToolRuntimeCacheForTests();
  registerToolsRuntimeAdapter();
}

/**
 * Report each slug as connected (`health: "active"`) to dispatch. Returns the restore function.
 * Dispatch only: every reader other than dispatch (for example discovery, chat-turn preload,
 * automation readiness, and the delivery sweep) still reads the real snapshot. A tool that declares `availability.credential` or `passthrough` needs the
 * raw `_setIntegrationAvailabilityReaderForTests` with `providers` rows.
 */
export function stubIntegrationHealthForTests(
  slugs: readonly LoadableIntegrationSlug[],
): () => void {
  const snapshot: IntegrationAvailabilitySnapshot = {
    integrations: new Map(slugs.map((slug) => [slug, { health: "active", accountLabel: null }])),
    providers: new Map(),
    passthroughEnabled: new Map(),
  };

  return _setIntegrationAvailabilityReaderForTests(() => Promise.resolve(snapshot));
}
