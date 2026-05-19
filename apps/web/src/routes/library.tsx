import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { FileText, Filter, MoreHorizontal, PartyPopper, Search, Star } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { Input } from "~/components/ui/input";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import {
  artifactMatchesType,
  LIBRARY_ARTIFACTS,
  matchesArtifact,
  type ArtifactType,
  type LibraryArtifact,
} from "~/lib/library-artifacts";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/library")({
  component: LibraryRoute,
});

type LibraryFilter = "all" | "favourites";

const FILTER_TABS: ReadonlyArray<TabItem<LibraryFilter>> = [
  { value: "all", label: "All Types", icon: <Filter size={14} /> },
  { value: "favourites", label: "Favourites", icon: <Star size={14} /> },
];

const TYPE_OPTIONS: ReadonlyArray<{ label: string; value: ArtifactType | "all" }> = [
  { label: "All Types", value: "all" },
  { label: "Presentations", value: "presentation" },
  { label: "Documents", value: "document" },
  { label: "Spreadsheets", value: "spreadsheet" },
  { label: "PDF Documents", value: "pdf" },
];

function LibraryRoute() {
  const hasChild = useChildMatches().length > 0;
  return (
    <>
      <LibraryPage dimmed={hasChild} />
      {hasChild ? <Outlet /> : null}
    </>
  );
}

function LibraryPage({ dimmed = false }: { dimmed?: boolean }) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<ArtifactType>>(new Set());
  const typeMenuId = useId();

  const artifacts = useMemo(() => {
    return LIBRARY_ARTIFACTS.filter((artifact) => {
      if (filter === "favourites" && !artifact.favourite) return false;
      if (!artifactMatchesType(artifact, types)) return false;
      return matchesArtifact(artifact, query);
    });
  }, [filter, query, types]);

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14",
        dimmed && "pointer-events-none select-none opacity-35",
      )}
    >
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Library
        </h1>
        <p className="text-sm text-gray-800">Browse all your created artifacts.</p>
      </header>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex items-center gap-2">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={typeMenuOpen}
            aria-controls={typeMenuId}
            onClick={() => setTypeMenuOpen((open) => !open)}
            className="frost-border inline-flex h-[37px] items-center gap-2 rounded-full bg-gradient-to-b from-[#0c0c0c] to-[#151515] px-4 text-sm font-medium text-gray-1000 shadow-[inset_0_0_4px_rgba(0,0,0,0.4)] outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-purple-500"
          >
            <Filter size={14} />
            All Types
          </button>
          <Tabs<LibraryFilter>
            variant="pill"
            value={filter}
            onValueChange={setFilter}
            items={FILTER_TABS.slice(1)}
            label="Library secondary filter"
          />

          {typeMenuOpen ? (
            <TypeMenu id={typeMenuId} selectedTypes={types} onSelectedTypesChange={setTypes} />
          ) : null}
        </div>
        <div className="w-full sm:w-[320px]">
          <Input
            variant="search"
            leading={<Search size={14} />}
            placeholder="Search artifacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="!h-[40px]"
            aria-label="Search artifacts"
          />
        </div>
      </div>

      <div className="mt-10">
        {artifacts.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        ) : (
          <LibraryEmpty filter={filter} query={query} />
        )}
      </div>
    </div>
  );
}

function TypeMenu({
  id,
  selectedTypes,
  onSelectedTypesChange,
}: {
  id: string;
  selectedTypes: Set<ArtifactType>;
  onSelectedTypesChange: (types: Set<ArtifactType>) => void;
}) {
  const toggleType = (value: ArtifactType | "all") => {
    if (value === "all") {
      onSelectedTypesChange(new Set());
      return;
    }
    const next = new Set(selectedTypes);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onSelectedTypesChange(next);
  };

  return (
    <div
      id={id}
      role="dialog"
      aria-label="Artifact types"
      className="absolute left-0 top-11 z-10 w-[250px] rounded-2xl border border-white/[0.08] bg-[#101010]/75 p-3 shadow-pop backdrop-blur-md"
    >
      <div className="mb-2 rounded-xl border border-white/[0.06] bg-[#1c1c1c]/80 px-3 py-2 text-[13px] text-gray-700">
        Filter artifact types
      </div>
      <div role="listbox" aria-label="Artifact types" className="space-y-1">
        {TYPE_OPTIONS.map((type) => {
          const checked =
            type.value === "all" ? selectedTypes.size === 0 : selectedTypes.has(type.value);
          return (
            <label
              key={type.value}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-gray-900 hover:bg-white/[0.04]"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleType(type.value)}
                className="size-4 rounded border border-white/10 accent-[rgb(83,59,229)]"
              />
              <span>{type.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ArtifactCard({ artifact }: { artifact: LibraryArtifact }) {
  return (
    <Link
      to="/library/$artifact"
      params={{ artifact: artifact.id }}
      className="group overflow-hidden rounded-3xl border border-white/[0.06] bg-[#141414] outline-none transition-[background-color,transform] duration-200 hover:bg-[#181818] focus-visible:ring-2 focus-visible:ring-purple-500 active:scale-[0.99]"
    >
      <div className="aspect-[4/3] border-b border-white/[0.06] bg-[#0f0f0f] p-4">
        {artifact.pages[0]?.html ? (
          <ArtifactPageFrame
            html={artifact.pages[0].html}
            title={`${artifact.title} cover preview`}
            className="mx-auto h-full max-w-[210px] rounded-lg"
          />
        ) : (
          <div className="mx-auto flex h-full max-w-[210px] flex-col rounded-lg bg-[#ededed] p-4 text-black shadow-2xl">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-black/45">
              {artifact.pages[0]?.kicker}
            </p>
            <p className="mt-3 text-lg font-semibold leading-5">{artifact.pages[0]?.title}</p>
            <p className="mt-3 line-clamp-5 text-[11px] leading-4 text-black/60">
              {artifact.pages[0]?.body}
            </p>
          </div>
        )}
      </div>
      <div className="flex items-start gap-3 p-4">
        <span
          aria-hidden
          className="frost-icon-tile grid size-9 shrink-0 place-items-center rounded-xl text-gray-900"
        >
          <FileText size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-1000">{artifact.title}</p>
          <p className="mt-0.5 truncate text-[12px] text-gray-800">
            {artifact.typeLabel} · {artifact.updatedLabel}
          </p>
        </div>
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-xl text-gray-800 transition-colors group-hover:text-gray-950"
        >
          <MoreHorizontal size={16} />
        </span>
      </div>
    </Link>
  );
}

function LibraryEmpty({ filter, query }: { filter: LibraryFilter; query: string }) {
  const isSearching = query.trim().length > 0;
  const title = isSearching
    ? "No matches"
    : filter === "favourites"
      ? "Nothing favourited yet"
      : "No artifacts yet";
  const description = isSearching
    ? `No artifacts match "${query}".`
    : filter === "favourites"
      ? "Star anything Alfred produces to keep it close by."
      : "Generated documents, drafts, and research artifacts will appear here once Alfred starts producing them.";

  return (
    <div className="grid min-h-[280px] place-items-center text-center">
      <div className="flex flex-col items-center">
        <PartyPopper size={40} className="text-white/80 mix-blend-plus-lighter" strokeWidth={1.5} />
        <p className="mt-3 text-sm font-medium text-gray-950">{title}</p>
        <p className="mt-1 max-w-[28rem] text-[12.5px] leading-relaxed text-gray-800">
          {description}
        </p>
      </div>
    </div>
  );
}
