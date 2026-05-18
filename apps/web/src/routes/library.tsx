import { createFileRoute } from "@tanstack/react-router";
import { Filter, PartyPopper, Search, Star } from "lucide-react";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Tabs, type TabItem } from "~/components/ui/tabs";

export const Route = createFileRoute("/library")({
  component: LibraryPage,
});

/* Dimension's library page filters via two pills: All Types + Favourites.
 * We mirror that grammar even though artifacts don't exist yet — the empty
 * state holds the layout so the route doesn't feel half-built. */
type LibraryFilter = "all" | "favourites";

const FILTER_TABS: ReadonlyArray<TabItem<LibraryFilter>> = [
  { value: "all", label: "All Types", icon: <Filter size={14} /> },
  { value: "favourites", label: "Favourites", icon: <Star size={14} /> },
];

function LibraryPage() {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [query, setQuery] = useState("");

  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Library
        </h1>
        <p className="text-sm text-gray-800">
          Browse all your created artifacts.
        </p>
      </header>

      {/* Toolbar — filter pills on the left, search on the right. Stacks on
       * narrow screens so the search input never collapses below ~280px. */}
      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs<LibraryFilter>
          variant="pill"
          value={filter}
          onValueChange={setFilter}
          items={FILTER_TABS}
          label="Library filter"
        />
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
        <LibraryEmpty filter={filter} query={query} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                */
/* -------------------------------------------------------------------------- */

function LibraryEmpty({
  filter,
  query,
}: {
  filter: LibraryFilter;
  query: string;
}) {
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
        <PartyPopper
          size={40}
          className="text-white/80 mix-blend-plus-lighter"
          strokeWidth={1.5}
        />
        <p className="mt-3 text-sm font-medium text-gray-950">{title}</p>
        <p className="mt-1 max-w-[28rem] text-[12.5px] leading-relaxed text-gray-800">
          {description}
        </p>
      </div>
    </div>
  );
}
