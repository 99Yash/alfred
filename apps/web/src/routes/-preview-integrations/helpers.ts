import {
  CATEGORY_ORDER,
  INTEGRATION_PROVIDERS,
  matchesIntegration,
  type IntegrationCategory,
  type IntegrationProvider,
} from "~/lib/integrations";
import type { IntegrationBrand } from "~/lib/integration-icons";

export type Section = {
  title: IntegrationCategory;
  providers: ReadonlyArray<IntegrationProvider>;
};

/* Brands whose monochrome glyph was tuned for dark surfaces only (white on
 * dark gradient). On light backgrounds the glyph disappears, so we flip
 * them to currentColor and let the wrapper provide the legible tone. */
export const MONOCHROME_BRANDS = new Set<IntegrationBrand>(["github"]);

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

export function filterSections(query: string): ReadonlyArray<Section> {
  return CATEGORY_ORDER.flatMap((category) => {
    const providers = INTEGRATION_PROVIDERS.filter(
      (provider) => provider.category === category && matchesIntegration(provider, query),
    );
    return providers.length > 0 ? [{ title: category, providers }] : [];
  });
}
