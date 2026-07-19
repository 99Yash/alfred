import { useMemo } from "react";
import { useResolvedIntegrations } from "~/lib/integrations/use-integration-status";
import {
  buildConnectedSection,
  filterSections,
  matches,
  MCP_HAYSTACK,
  type Section,
} from "./helpers";

export interface IntegrationCatalog {
  /** Connected section (if any) floated above the filtered category sections. */
  sections: ReadonlyArray<Section>;
  /** Whether the MCP-server section matches the current query. */
  mcpVisible: boolean;
  /** No catalog section and no MCP section survive the query. */
  empty: boolean;
}

/**
 * Resolve the integration catalog against the user's live credentials and
 * filter it by `query`. Shared by the full `/integrations` page and the
 * chat "Connect your tools" dialog so both derive the same sections from one
 * place. Mirrors dimension's `AllIntegrationsDialog` grouping.
 */
export function useIntegrationCatalog(query: string): IntegrationCatalog {
  const resolved = useResolvedIntegrations();

  // The "Connected" section is synthesised on top of the resolved overlay.
  // Drop connected providers from the category sweep so they don't render
  // twice (once floating, once in their natural category).
  const { connectedSection, remainingProviders } = useMemo(() => {
    const connected = buildConnectedSection(resolved, query);
    const remaining = connected ? resolved.filter((p) => p.status !== "connected") : resolved;
    return { connectedSection: connected, remainingProviders: remaining };
  }, [resolved, query]);

  const filtered = useMemo(
    () => filterSections(remainingProviders, query),
    [remainingProviders, query],
  );
  const sections = useMemo(
    () => (connectedSection ? [connectedSection, ...filtered] : filtered),
    [connectedSection, filtered],
  );

  const mcpVisible = matches(MCP_HAYSTACK, query);
  const empty = sections.length === 0 && !mcpVisible;

  return { sections, mcpVisible, empty };
}
