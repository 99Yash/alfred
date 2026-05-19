import { createFileRoute } from "@tanstack/react-router";
import { Filter, PartyPopper, Search, Star } from "lucide-react";
import { useId, useState } from "react";
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
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const typeMenuId = useId();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Library
        </h1>
        <p className="text-sm text-gray-800">Browse all your created artifacts.</p>
      </header>

      {/* Toolbar — filter pills on the left, search on the right. Stacks on
       * narrow screens so the search input never collapses below ~280px. */}
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
            <div
              id={typeMenuId}
              role="dialog"
              aria-label="Artifact types"
              className="absolute left-0 top-11 z-10 w-[250px] rounded-2xl border border-white/[0.08] bg-[#101010]/75 p-3 shadow-pop backdrop-blur-md"
            >
              <div className="mb-2 rounded-xl border border-white/[0.06] bg-[#1c1c1c]/80 px-3 py-2 text-[13px] text-gray-700">
                Filter artifact types
              </div>
              <div role="listbox" aria-label="Artifact types" className="space-y-1">
                {["All Types", "Presentations", "Documents", "Spreadsheets", "PDF Documents"].map(
                  (type, index) => (
                    <label
                      key={type}
                      className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm text-gray-900 hover:bg-white/[0.04]"
                    >
                      <input
                        type="checkbox"
                        defaultChecked={index === 0}
                        className="size-4 rounded border border-white/10 accent-[rgb(83,59,229)]"
                      />
                      <span>{type}</span>
                    </label>
                  ),
                )}
              </div>
            </div>
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
        <LibraryEmpty filter={filter} query={query} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                */
/* -------------------------------------------------------------------------- */

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
