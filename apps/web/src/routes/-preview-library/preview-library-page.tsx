import { Filter, Search, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { AppInput, AppSegmented } from "~/components/ui/v2";
import {
  artifactMatchesType,
  LIBRARY_ARTIFACTS,
  matchesArtifact,
  type ArtifactType,
} from "~/lib/artifacts/library-artifacts";
import { cn } from "~/lib/utils";
import { ArtifactCard } from "./artifact-card";
import type { LibraryFilter } from "./helpers";
import { LibraryEmpty } from "./library-empty";
import { TypeFilterPopover } from "./type-filter-popover";

const FILTER_TABS = [
  {
    value: "all" as const,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Filter size={13} /> All
      </span>
    ),
  },
  {
    value: "favourites" as const,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Star size={13} /> Favourites
      </span>
    ),
  },
];

export function PreviewLibraryPage({ dimmed = false }: { dimmed?: boolean }) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<ArtifactType>>(new Set());

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
        "flex-1 min-w-0 overflow-y-auto scroll-stable transition-opacity",
        dimmed && "pointer-events-none select-none opacity-35",
      )}
    >
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="space-y-3 text-center app-card-in">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-app-fg-4">
            Library
          </h1>
          <p className="text-sm text-app-fg-3">Browse all your created artifacts.</p>
        </header>

        <div
          className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between app-card-in"
          style={{ animationDelay: "100ms" }}
        >
          <div className="flex items-center gap-2">
            <TypeFilterPopover selectedTypes={types} onSelectedTypesChange={setTypes} />
            <AppSegmented<LibraryFilter>
              value={filter}
              onValueChange={setFilter}
              items={FILTER_TABS}
              label="Library secondary filter"
            />
          </div>
          <div className="relative w-full sm:w-[300px]">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-fg-2"
            />
            <AppInput
              placeholder="Search artifacts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search artifacts"
              className="!h-9 pl-9"
            />
          </div>
        </div>

        <div className="mt-10">
          {artifacts.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {artifacts.map((artifact, i) => (
                <ArtifactCard key={artifact.id} artifact={artifact} index={i} />
              ))}
            </div>
          ) : (
            <LibraryEmpty filter={filter} query={query} />
          )}
        </div>
      </main>
    </div>
  );
}
