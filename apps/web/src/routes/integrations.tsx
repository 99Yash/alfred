import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { Plug, Plus, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  CATEGORY_ORDER,
  INTEGRATION_PROVIDERS,
  matchesIntegration,
  type IntegrationCategory,
  type IntegrationProvider,
} from "~/lib/integrations";
import { IntegrationIcon } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/integrations")({
  component: IntegrationsRoute,
});

type Section = {
  title: IntegrationCategory;
  providers: ReadonlyArray<IntegrationProvider>;
};

const MCP_SECTION = {
  heading: "Your Integrations",
  name: "MCP Server",
  description: "Connect any MCP server to extend Alfred.",
} as const;

const MCP_HAYSTACK = `${MCP_SECTION.heading} ${MCP_SECTION.name} ${MCP_SECTION.description}`;

function IntegrationsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <IntegrationsPage />;
}

function IntegrationsPage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => filterSections(query), [query]);
  const mcpVisible = matches(MCP_HAYSTACK, query);
  const empty = filtered.length === 0 && !mcpVisible;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Integrations
        </h1>
        <p className="text-sm text-gray-800">
          Connect the tools Alfred can read, write, and act on.
        </p>
        <div className="pt-4 flex justify-center">
          <Input
            variant="search"
            leading={<Search size={14} />}
            placeholder="Search for integration"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="!h-[46px] max-w-[640px]"
            aria-label="Search integrations"
          />
        </div>
      </header>

      <div className="mt-12 space-y-12">
        {filtered.map((section) => (
          <SectionBlock key={section.title} section={section} />
        ))}
        {mcpVisible ? <MCPServerSection /> : null}

        {empty ? (
          <p className="text-center text-sm text-gray-800">
            No integrations match &ldquo;{query}&rdquo;.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[15px] font-medium text-gray-1000">{section.title}</h2>
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
        {section.providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({ provider }: { provider: IntegrationProvider }) {
  const content = (
    <>
      <IntegrationIcon
        brand={provider.brand}
        size="md"
        connected={provider.status === "connected"}
        title={provider.name}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-950">{provider.name}</p>
        <p className="truncate text-[12.5px] text-gray-800">{provider.description}</p>
      </div>
      <ActionPill status={provider.status}>{provider.actionLabel}</ActionPill>
    </>
  );

  if (provider.status === "soon") {
    return (
      <Card
        aria-disabled
        className="flex items-center gap-3 px-3 py-2.5 text-gray-950 opacity-70 cursor-not-allowed"
      >
        {content}
      </Card>
    );
  }

  return (
    <Link
      to="/integrations/$provider"
      params={{ provider: provider.id }}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-gray-950",
        "transition-[background-color] duration-200",
        "outline-none hover:bg-[#181818] focus-visible:bg-[#181818] focus-visible:outline-none",
      )}
    >
      {content}
    </Link>
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
        "inline-flex h-8 shrink-0 items-center justify-center rounded-full px-3.5 text-sm font-medium",
        status === "soon"
          ? "bg-gray-100 text-gray-700"
          : "bg-white/[0.05] text-gray-800 group-hover:text-gray-900",
      )}
    >
      {children}
    </span>
  );
}

function MCPServerSection() {
  return (
    <section className="space-y-3">
      <h2 className="text-[15px] font-medium text-gray-1000">{MCP_SECTION.heading}</h2>
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
        <Card
          aria-disabled
          className="flex items-center gap-3 px-3 py-2.5 text-gray-950 opacity-70 cursor-not-allowed"
        >
          <span
            className="frost-icon-tile grid size-10 shrink-0 place-items-center rounded-xl text-gray-900"
            aria-hidden
          >
            <Plug size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-950">{MCP_SECTION.name}</p>
            <p className="truncate text-[12.5px] text-gray-800">{MCP_SECTION.description}</p>
          </div>
          <span className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-gray-100 px-3.5 text-sm font-medium text-gray-700">
            <Plus size={14} />
            Add
          </span>
        </Card>
      </div>
    </section>
  );
}

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
