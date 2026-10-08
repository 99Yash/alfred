import { useMemo } from "react";
import { useResolvedIntegrations } from "~/lib/integrations/use-integration-status";
import {
  buildConnectedSection,
  filterSections,
  matches,
  type Section,
  BUILT_IN_MCP_HAYSTACK,
} from "./helpers";

export interface IntegrationCatalog {
  /** The connected section, if any, then the filtered categories. */
  sections: ReadonlyArray<Section>;
  mcpVisible: boolean;
  /** Nothing matches the query. */
  empty: boolean;
}

/** The catalog resolved against live credentials and filtered by `query`. Shared by the page and the dialog. */
export function useIntegrationCatalog(query: string): IntegrationCatalog {
  const resolved = useResolvedIntegrations();

  // Connected providers float on top, so drop them from their categories.
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

  const mcpVisible = matches(BUILT_IN_MCP_HAYSTACK, query);
  const empty = sections.length === 0 && !mcpVisible;

  return { sections, mcpVisible, empty };
}
