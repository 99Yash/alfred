/**
 * The object-state vocabulary that `user-model.ts` names (ADR-0062). It reads only the registry and
 * the kind leaf, so `user-model.ts` can name it without an import cycle through
 * `integration-objects.ts`.
 */

import { INTEGRATIONS, INTEGRATION_SLUGS, type IntegrationSlug } from "./integrations/registry";
import type { SourceDecl } from "./object-kind";

/**
 * Each registry slug whose entry declares a source (ADR-0122 decision 1). Derived, so a registry
 * entry that gains a `source` joins every table keyed by {@link ObjectStateProvider}.
 */
export type BuiltInSourceSlug = {
  [S in IntegrationSlug]: (typeof INTEGRATIONS)[S] extends { readonly source: SourceDecl }
    ? S
    : never;
}[IntegrationSlug];

function declaresSource(slug: IntegrationSlug): slug is BuiltInSourceSlug {
  return "source" in INTEGRATIONS[slug];
}

/**
 * The owner of an `integration_objects` row: a built-in source, or `mcp` for an owner-reviewed MCP
 * health mapping. `mcp` leaves when the MCP rows take a `SourceIdentity` (ADR-0118 decision 2).
 */
export type ObjectStateProvider = BuiltInSourceSlug | "mcp";

/** In registry order, then `mcp`. */
export const OBJECT_STATE_PROVIDERS: readonly ObjectStateProvider[] = [
  ...INTEGRATION_SLUGS.filter(declaresSource),
  "mcp",
];

/**
 * How a key that an adapter reads from text finds its object. `prefix` is for an abbreviated sha,
 * which an exact lookup on the 40-hex key cannot find.
 */
export const OBJECT_KEY_MATCHES = ["exact", "prefix"] as const;

export type ObjectKeyMatch = (typeof OBJECT_KEY_MATCHES)[number];
