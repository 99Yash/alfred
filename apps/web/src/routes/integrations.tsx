import { createFileRoute } from "@tanstack/react-router";
import { Plug, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
});

type Status = "connected" | "available" | "soon";

type Provider = {
  name: string;
  description: string;
  status: Status;
  brand: IntegrationBrand;
};

type Section = {
  title: string;
  providers: ReadonlyArray<Provider>;
};

const SECTIONS: ReadonlyArray<Section> = [
  {
    title: "Connected",
    providers: [
      {
        name: "Gmail",
        description: "Inbox triage, draft review, and briefing inputs.",
        status: "connected",
        brand: "gmail",
      },
      {
        name: "Google Calendar",
        description: "Meetings, daily context, and scheduling actions.",
        status: "connected",
        brand: "google_calendar",
      },
      {
        name: "Google Drive",
        description: "Docs and files for research-backed answers.",
        status: "connected",
        brand: "google_drive",
      },
    ],
  },
  {
    title: "Apps",
    providers: [
      {
        name: "Slack",
        description: "Text Alfred from a Slack DM.",
        status: "soon",
        brand: "slack",
      },
    ],
  },
  {
    title: "Productivity",
    providers: [
      {
        name: "Google Docs",
        description: "Read and edit Google Docs in place.",
        status: "available",
        brand: "google_docs",
      },
      {
        name: "Google Sheets",
        description: "Work with spreadsheets and named ranges.",
        status: "available",
        brand: "google_sheets",
      },
      {
        name: "Google Slides",
        description: "Create and edit Google Slides decks.",
        status: "available",
        brand: "google_slides",
      },
      {
        name: "Linear",
        description: "Manage Linear issues and projects.",
        status: "soon",
        brand: "linear",
      },
    ],
  },
  {
    title: "Development",
    providers: [
      {
        name: "GitHub",
        description: "Repositories, pull requests, issues, and release context.",
        status: "available",
        brand: "github",
      },
    ],
  },
];

function IntegrationsPage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => filterSections(SECTIONS, query), [query]);
  const mcpVisible = matches("MCP Server Connect any MCP server", query);
  const empty = filtered.length === 0 && !mcpVisible;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
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
          <ProviderRow key={provider.name} provider={provider} />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  return (
    <Card
      interactive
      className={cn(
        "flex items-center gap-3 px-3 py-2.5",
        /* Card defaults text to gray-800 — bump container so name reads at the
         * intended weight. Per-element overrides below pick up the proper stops. */
        "text-gray-950",
      )}
    >
      <IntegrationIcon
        brand={provider.brand}
        size="md"
        connected={false}
        title={provider.name}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-950">
          {provider.name}
        </p>
        <p className="truncate text-[12.5px] text-gray-800">
          {provider.description}
        </p>
      </div>
      <ActionButton status={provider.status} provider={provider.name} />
    </Card>
  );
}

function ActionButton({
  status,
  provider,
}: {
  status: Status;
  provider: string;
}) {
  if (status === "connected") {
    return (
      <Button variant="ghost" size="md" aria-label={`Manage ${provider}`}>
        Manage
      </Button>
    );
  }
  if (status === "available") {
    return (
      <Button variant="ghost" size="md" aria-label={`Connect ${provider}`}>
        Connect
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="md"
      disabled
      aria-label={`${provider} coming soon`}
    >
      Coming Soon
    </Button>
  );
}

function MCPServerSection() {
  return (
    <section className="space-y-3">
      <h2 className="text-[15px] font-medium text-gray-1000">
        Your Integrations
      </h2>
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
        <Card interactive className="flex items-center gap-3 px-3 py-2.5">
          <span
            className="frost-icon-tile grid size-10 shrink-0 place-items-center rounded-xl text-gray-900"
            aria-hidden
          >
            <Plug size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-950">
              MCP Server
            </p>
            <p className="truncate text-[12.5px] text-gray-800">
              Connect any MCP server to extend Alfred.
            </p>
          </div>
          <Button
            variant="ghost"
            size="md"
            leading={<Plus size={14} />}
            disabled
            aria-label="Add MCP server (coming soon)"
          >
            Add
          </Button>
        </Card>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Filter helpers                                                              */
/* -------------------------------------------------------------------------- */

function matches(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

function filterSections(
  sections: ReadonlyArray<Section>,
  query: string,
): ReadonlyArray<Section> {
  if (!query.trim()) return sections;
  return sections
    .map((section) => ({
      ...section,
      providers: section.providers.filter((p) =>
        matches(`${p.name} ${p.description}`, query),
      ),
    }))
    .filter((section) => section.providers.length > 0);
}
