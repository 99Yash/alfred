import type { McpRecoveryOperation, McpRecoveryOperationsPage } from "@alfred/contracts";
import {
  CATEGORY_ORDER,
  matchesIntegration,
  type IntegrationCategory,
  type IntegrationPage,
} from "~/lib/integrations/integrations";

export type Section = {
  title: IntegrationCategory;
  providers: ReadonlyArray<IntegrationPage>;
};

export const MCP_SECTION = {
  heading: "Your Integrations",
  name: "MCP Server",
  description: "Connect any MCP server to extend Alfred.",
} as const;

export const MCP_HAYSTACK = `${MCP_SECTION.heading} ${MCP_SECTION.name} ${MCP_SECTION.description}`;

export function matches(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

export function filterSections(
  providers: ReadonlyArray<IntegrationPage>,
  query: string,
): ReadonlyArray<Section> {
  return CATEGORY_ORDER.flatMap((category) => {
    const matched = providers.filter(
      (provider) => provider.category === category && matchesIntegration(provider, query),
    );
    return matched.length > 0 ? [{ title: category, providers: matched }] : [];
  });
}

/**
 * Build the synthetic "Connected" section that floats above the catalog
 * categories. Mirrors how the static catalog used to declare connected
 * tiles upfront, but driven by real `useResolvedIntegrations()` state
 * instead of hardcoded `status: "connected"` rows.
 */
export function buildConnectedSection(
  resolved: ReadonlyArray<IntegrationPage>,
  query: string,
): Section | null {
  const connected = resolved.filter(
    (p) => p.status === "connected" && matchesIntegration(p, query),
  );
  if (connected.length === 0) return null;
  return { title: "Connected", providers: connected };
}

/** Every operation across the loaded recovery pages, in page order. */
export function flattenMcpRecoveryPages(
  pages: ReadonlyArray<McpRecoveryOperationsPage> | undefined,
): ReadonlyArray<McpRecoveryOperation> {
  return pages?.flatMap((page) => page.operations) ?? [];
}
