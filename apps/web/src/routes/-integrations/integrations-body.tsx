import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { AppInput } from "~/components/ui/v2";
import { useResolvedIntegrations } from "~/hooks/use-integration-status";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import { FeaturedHero } from "./featured-hero";
import { buildConnectedSection, filterSections, matches, MCP_HAYSTACK } from "./helpers";
import { MCPServerSection } from "./mcp-server-section";
import { SectionBlock } from "./section-block";

export function IntegrationsBody() {
  const [query, setQuery] = useState("");
  const resolved = useResolvedIntegrations();

  // The "Connected" section is synthesised on top of the resolved overlay
  // — the catalog no longer carries `status: "connected"` defaults. Drop
  // the connected providers from the category sweep so they don't render
  // twice (once in the floating section, once in their natural category).
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

  const connectedBrands = useMemo<ReadonlyArray<IntegrationBrand>>(() => {
    const brands: IntegrationBrand[] = [];
    for (const p of resolved) {
      if (p.status === "connected") brands.push(p.brand);
    }
    return brands;
  }, [resolved]);

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header className="app-card-in mx-auto max-w-2xl space-y-3 text-center">
          <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-app-fg-4">
            Integrations
          </h1>
          <p className="text-sm text-app-fg-3">
            Connect the tools Alfred can read, write, and act on.
          </p>
        </header>

        <FeaturedHero brands={connectedBrands} />

        <div className="app-card-in mt-8 flex justify-center" style={{ animationDelay: "120ms" }}>
          <div className="relative w-full max-w-[640px]">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-4 hidden -translate-y-1/2 text-app-fg-2 md:block"
            />
            <AppInput
              placeholder="Search for integration"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="!h-[44px] w-full !rounded-2xl !pl-10"
              aria-label="Search integrations"
            />
          </div>
        </div>

        <div className="mt-12 space-y-12">
          {sections.map((section, sIdx) => (
            <SectionBlock key={section.title} section={section} index={sIdx} />
          ))}
          {mcpVisible ? <MCPServerSection /> : null}
          {empty ? (
            <p className="text-center text-sm text-app-fg-3">
              No integrations match &ldquo;{query}&rdquo;.
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
