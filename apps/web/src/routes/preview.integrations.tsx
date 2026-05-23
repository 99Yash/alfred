import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { Plug, Plus, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { VsCard, VsInput } from "~/components/ui/visitors";
import {
  CATEGORY_ORDER,
  INTEGRATION_PROVIDERS,
  matchesIntegration,
  type IntegrationCategory,
  type IntegrationProvider,
} from "~/lib/integrations";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /integrations.
 *
 * Same IA + same data (CATEGORY_ORDER, INTEGRATION_PROVIDERS), rebuilt
 * with the visitors-now primitives. Adds:
 *   - A 3-tile floating hero showing connected provider logos (the
 *     "logos as a hero" treatment Yash called out, ported from the
 *     dimension integration detail page's HeroPreview).
 *   - VsCard rows with hue-aware status pills.
 *   - Connected-provider green status dot on the icon tile.
 *   - Staggered card entrance.
 *
 * Compare:
 *   /integrations           → dimension grammar (dark, dense row layout)
 *   /preview/integrations   → visitors-now grammar (theme-aware, hero, soft chips)
 */
export const Route = createFileRoute("/preview/integrations")({
  component: PreviewIntegrationsRoute,
});

function PreviewIntegrationsRoute() {
  // Defer to the child route when one is matched (e.g. /preview/integrations/$provider).
  // Without this, TanStack's flat-routes nesting renders the list as the
  // shared parent layout even on the detail URL. Mirrors `integrations.tsx`.
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewIntegrationsPage />;
}

function PreviewIntegrationsPage() {
  // Theme provider is owned by the parent layout (`routes/preview.tsx`).
  return <PreviewIntegrationsBody />;
}

function PreviewIntegrationsBody() {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterSections(query), [query]);
  const mcpVisible = matches(MCP_HAYSTACK, query);
  const empty = filtered.length === 0 && !mcpVisible;

  const connectedBrands = useMemo<ReadonlyArray<IntegrationBrand>>(() => {
    const brands: IntegrationBrand[] = [];
    for (const p of INTEGRATION_PROVIDERS) {
      if (p.status === "connected") brands.push(p.brand);
    }
    return brands;
  }, []);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-3 max-w-2xl mx-auto vs-card-in">
          <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-vs-fg-4">Integrations</h1>
          <p className="text-sm text-vs-fg-3">
            Connect the tools Alfred can read, write, and act on.
          </p>
        </header>

        <FeaturedHero brands={connectedBrands} />

        <div className="flex justify-center mt-8 vs-card-in" style={{ animationDelay: "120ms" }}>
          <VsInput
            placeholder="Search for integration"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-[640px] !h-[44px] !rounded-2xl !pl-10"
            aria-label="Search integrations"
          />
          <Search
            size={14}
            className="absolute -ml-[600px] mt-[15px] text-vs-fg-2 pointer-events-none hidden md:block"
          />
        </div>

        <div className="mt-12 space-y-12">
          {filtered.map((section, sIdx) => (
            <SectionBlock key={section.title} section={section} index={sIdx} />
          ))}
          {mcpVisible ? <MCPServerSection /> : null}
          {empty ? (
            <p className="text-center text-sm text-vs-fg-3">
              No integrations match &ldquo;{query}&rdquo;.
            </p>
          ) : null}
        </div>

        <footer className="mt-16 flex items-center justify-center text-xs text-vs-fg-2 gap-2">
          <span>Comparing against</span>
          <Link to="/integrations" className="font-medium text-vs-fg-3 hover:text-vs-fg-4">
            /integrations
          </Link>
        </footer>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Featured hero — 3 tiles arranged like dimension's HeroPreview but with */
/* the user's currently-connected provider logos. Soft tinted backdrop +  */
/* faint grid + radial highlight at the bottom.                            */
/* ----------------------------------------------------------------------- */

function FeaturedHero({ brands }: { brands: ReadonlyArray<IntegrationBrand> }) {
  // Pick 3 brands; if fewer than 3 connected, repeat the last one.
  const picks: [IntegrationBrand, IntegrationBrand, IntegrationBrand] = (() => {
    if (brands.length === 0) return ["gmail", "google_calendar", "google_drive"];
    const [a = brands[0]!, b = brands[0]!, c = brands[0]!] = brands;
    return [a, b, c];
  })();

  return (
    <div
      aria-hidden
      className={cn(
        "relative mt-8 h-[180px] w-full overflow-hidden rounded-3xl vs-card-in",
        "bg-vs-bg-2",
      )}
      style={{ animationDelay: "60ms" }}
    >
      {/* Grid backdrop with radial mask — subtle texture */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-50 dark:opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--vs-bg-a2) 1px, transparent 1px), linear-gradient(to bottom, var(--vs-bg-a2) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(60% 60% at 50% 50%, black 0%, rgba(0,0,0,0.5) 60%, transparent 100%)",
        }}
      />
      {/* Radial accent at center-bottom */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 110%, var(--vs-purple-2) 0%, transparent 55%)",
        }}
      />
      <div className="relative flex h-full items-center justify-center gap-6 group">
        <HeroTile brand={picks[0]!} variant="side" rotate={-4} />
        <HeroTile brand={picks[1]!} variant="center" />
        <HeroTile brand={picks[2]!} variant="side" rotate={4} />
      </div>
    </div>
  );
}

function HeroTile({
  brand,
  variant,
  rotate = 0,
}: {
  brand: IntegrationBrand;
  variant: "center" | "side";
  rotate?: number;
}) {
  const isCenter = variant === "center";
  const isMono = MONOCHROME_BRANDS.has(brand);
  return (
    <div
      className={cn(
        "grid place-items-center bg-vs-bg-1 vs-stack transition-transform",
        isCenter ? "size-[112px] rounded-[26px]" : "size-[84px] rounded-[20px] opacity-90",
        "shadow-[var(--vs-shadow-elevated)]",
        isMono && "text-vs-fg-4",
      )}
      style={{
        transform: `rotate(${rotate}deg)`,
      }}
    >
      <IntegrationGlyph
        brand={brand}
        size={isCenter ? 48 : 36}
        colorOverride={isMono ? "var(--vs-fg-4)" : undefined}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Section block + provider row                                            */
/* ----------------------------------------------------------------------- */

type Section = {
  title: IntegrationCategory;
  providers: ReadonlyArray<IntegrationProvider>;
};

function SectionBlock({ section, index }: { section: Section; index: number }) {
  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: `${180 + index * 60}ms` }}>
      <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">
        {section.title}
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {section.providers.map((provider, i) => (
          <ProviderRow key={provider.id} provider={provider} index={i} />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({ provider, index }: { provider: IntegrationProvider; index: number }) {
  const isSoon = provider.status === "soon";
  const content = (
    <>
      <ProviderTile brand={provider.brand} connected={provider.status === "connected"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-vs-fg-4">{provider.name}</p>
        <p className="truncate text-xs text-vs-fg-3">{provider.description}</p>
      </div>
      <ActionPill status={provider.status}>{provider.actionLabel}</ActionPill>
    </>
  );

  const cardClassName = cn(
    "vs-card-in flex items-center gap-3 px-3 py-2.5 text-sm",
    isSoon && "opacity-60 cursor-not-allowed",
  );

  if (isSoon) {
    return (
      <VsCard
        padded={false}
        aria-disabled
        className={cardClassName}
        style={{ animationDelay: `${240 + index * 40}ms` }}
      >
        {content}
      </VsCard>
    );
  }

  return (
    <Link
      to="/preview/integrations/$provider"
      params={{ provider: provider.id }}
      className={cn(
        cardClassName,
        "rounded-2xl bg-vs-bg-1 overflow-hidden",
        "shadow-[var(--vs-shadow-elevated)]",
        "transition-shadow vs-press",
        "hover:shadow-[var(--vs-shadow-elevated-hover)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
      style={{ animationDelay: `${240 + index * 40}ms` }}
    >
      {content}
    </Link>
  );
}

/* Brands whose monochrome glyph was tuned for dark surfaces only (white on
 * dark gradient). On light backgrounds the glyph disappears, so we flip
 * them to currentColor and let the wrapper provide the legible tone. */
const MONOCHROME_BRANDS = new Set<IntegrationBrand>(["github"]);

function ProviderTile({ brand, connected }: { brand: IntegrationBrand; connected: boolean }) {
  const isMono = MONOCHROME_BRANDS.has(brand);
  return (
    <span
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-xl bg-vs-bg-2 ring-1 ring-vs-bg-3",
        // For brands whose glyph relies on currentColor (via colorOverride below),
        // text-vs-fg-4 supplies the legible tone in both themes.
        isMono && "text-vs-fg-4",
      )}
    >
      <IntegrationGlyph brand={brand} size={22} colorOverride={isMono ? "var(--vs-fg-4)" : undefined} />
      {connected ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-vs-green-4 ring-2 ring-vs-background"
          aria-label="Connected"
        />
      ) : null}
    </span>
  );
}

function ActionPill({
  status,
  children,
}: {
  status: IntegrationProvider["status"];
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-medium",
        status === "connected" && "bg-vs-green-1 text-vs-green-4",
        status === "available" && "bg-vs-bg-2 text-vs-fg-3",
        status === "soon" && "bg-vs-bg-2 text-vs-fg-2",
      )}
    >
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------------- */
/* MCP server tease                                                        */
/* ----------------------------------------------------------------------- */

const MCP_SECTION = {
  heading: "Your Integrations",
  name: "MCP Server",
  description: "Connect any MCP server to extend Alfred.",
} as const;

const MCP_HAYSTACK = `${MCP_SECTION.heading} ${MCP_SECTION.name} ${MCP_SECTION.description}`;

function MCPServerSection() {
  return (
    <section
      className="space-y-3 vs-card-in"
      style={{ animationDelay: `${480}ms` }}
    >
      <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">
        {MCP_SECTION.heading}
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        <VsCard
          padded={false}
          aria-disabled
          className="flex items-center gap-3 px-3 py-2.5 opacity-70 cursor-not-allowed"
        >
          <span
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-vs-bg-2 ring-1 ring-vs-bg-3 text-vs-fg-3"
            aria-hidden
          >
            <Plug size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-vs-fg-4">{MCP_SECTION.name}</p>
            <p className="truncate text-xs text-vs-fg-3">{MCP_SECTION.description}</p>
          </div>
          <span className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg bg-vs-bg-2 px-2.5 text-xs font-medium text-vs-fg-2">
            <Plus size={12} />
            Add
          </span>
        </VsCard>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------------- */
/* Helpers                                                                  */
/* ----------------------------------------------------------------------- */

function matches(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

function filterSections(query: string): ReadonlyArray<Section> {
  return CATEGORY_ORDER.flatMap((category) => {
    const providers = INTEGRATION_PROVIDERS.filter(
      (provider) => provider.category === category && matchesIntegration(provider, query),
    );
    return providers.length > 0 ? [{ title: category, providers }] : [];
  });
}
