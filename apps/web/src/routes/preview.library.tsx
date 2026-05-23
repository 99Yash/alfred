import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
} from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  Filter,
  MoreHorizontal,
  PartyPopper,
  Presentation,
  Search,
  Star,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { VsInput, VsSegmented } from "~/components/ui/visitors";
import {
  artifactMatchesType,
  LIBRARY_ARTIFACTS,
  matchesArtifact,
  type ArtifactType,
  type LibraryArtifact,
} from "~/lib/library-artifacts";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /library.
 *
 * Same data + filter behavior as the dimension page (Type popover +
 * All/Favourites pill + search) over the fixture `LIBRARY_ARTIFACTS`.
 * Card cover preview reuses `ArtifactPageFrame` so the rendered HTML
 * pages from the archive still drive the thumbnail.
 *
 * The detail viewer (`preview.library.$artifact.tsx`) renders on top of
 * the list as a fullscreen overlay — the dimension version uses Radix
 * Dialog; we use a simple fixed overlay to keep the styling under our
 * control. When a child route is active the list dims and stops
 * accepting pointer events.
 */
export const Route = createFileRoute("/preview/library")({
  component: PreviewLibraryRoute,
});

function PreviewLibraryRoute() {
  const hasChild = useChildMatches().length > 0;
  return (
    <>
      <PreviewLibraryPage dimmed={hasChild} />
      {hasChild ? <Outlet /> : null}
    </>
  );
}

type LibraryFilter = "all" | "favourites";

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

const TYPE_OPTIONS: ReadonlyArray<{ label: string; value: ArtifactType | "all" }> = [
  { label: "All types", value: "all" },
  { label: "Presentations", value: "presentation" },
  { label: "Documents", value: "document" },
  { label: "Spreadsheets", value: "spreadsheet" },
  { label: "PDF Documents", value: "pdf" },
];

const TYPE_TINT: Record<
  ArtifactType,
  { bg: string; fg: string; ring: string; icon: LucideIcon }
> = {
  document: {
    bg: "bg-vs-blue-1",
    fg: "text-vs-blue-4",
    ring: "ring-vs-blue-2",
    icon: FileText,
  },
  pdf: { bg: "bg-vs-red-1", fg: "text-vs-red-4", ring: "ring-vs-red-2", icon: FileText },
  presentation: {
    bg: "bg-vs-amber-1",
    fg: "text-vs-amber-4",
    ring: "ring-vs-amber-2",
    icon: Presentation,
  },
  spreadsheet: {
    bg: "bg-vs-green-1",
    fg: "text-vs-green-4",
    ring: "ring-vs-green-2",
    icon: FileSpreadsheet,
  },
};

function PreviewLibraryPage({ dimmed = false }: { dimmed?: boolean }) {
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
        "flex-1 min-w-0 overflow-y-auto vs-scrollbar transition-opacity",
        dimmed && "pointer-events-none select-none opacity-35",
      )}
    >
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="space-y-3 text-center vs-card-in">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-vs-fg-4">
            Library
          </h1>
          <p className="text-sm text-vs-fg-3">Browse all your created artifacts.</p>
        </header>

        <div
          className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between vs-card-in"
          style={{ animationDelay: "100ms" }}
        >
          <div className="flex items-center gap-2">
            <TypeFilterPopover selectedTypes={types} onSelectedTypesChange={setTypes} />
            <VsSegmented<LibraryFilter>
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
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-vs-fg-2"
            />
            <VsInput
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

function TypeFilterPopover({
  selectedTypes,
  onSelectedTypesChange,
}: {
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
  const label = selectedTypes.size === 0 ? "All types" : `${selectedTypes.size} selected`;

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-xl px-3",
            "bg-vs-bg-1 text-sm font-medium text-vs-fg-4",
            "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none transition-colors hover:bg-vs-bg-a1",
            "focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
            "data-[state=open]:bg-vs-bg-a1",
            "vs-press",
          )}
        >
          <Filter size={13} />
          {label}
          <ChevronDown size={13} className="text-vs-fg-2" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className={cn(
            "z-50 w-[250px] rounded-2xl bg-vs-bg-1 p-2",
            "shadow-[0_18px_48px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
            "outline-none vs-fade-in",
          )}
        >
          <div className="mb-1 px-2 pb-1 pt-1 text-[11px] uppercase tracking-tight text-vs-fg-2">
            Filter types
          </div>
          <div aria-label="Artifact types" className="space-y-0.5">
            {TYPE_OPTIONS.map((type) => {
              const checked =
                type.value === "all" ? selectedTypes.size === 0 : selectedTypes.has(type.value);
              return (
                <button
                  key={type.value}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => toggleType(type.value)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm",
                    "text-vs-fg-3 outline-none transition-colors",
                    "hover:bg-vs-bg-a1 hover:text-vs-fg-4",
                    "focus-visible:bg-vs-bg-a1 focus-visible:text-vs-fg-4",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded text-[10px]",
                      checked
                        ? "bg-[image:var(--vs-cta-bg)] text-[var(--vs-accent-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                        : "bg-vs-bg-2 text-transparent shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]",
                    )}
                  >
                    <Check size={11} strokeWidth={2.4} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{type.label}</span>
                </button>
              );
            })}
          </div>
          {selectedTypes.size > 0 ? (
            <button
              type="button"
              onClick={() => onSelectedTypesChange(new Set())}
              className={cn(
                "mt-1 h-7 w-full rounded-lg text-[12px] text-vs-fg-3 outline-none",
                "hover:bg-vs-bg-a1 hover:text-vs-fg-4",
                "focus-visible:ring-2 focus-visible:ring-vs-purple-2",
              )}
            >
              Clear filters
            </button>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function ArtifactCard({ artifact, index }: { artifact: LibraryArtifact; index: number }) {
  const tint = TYPE_TINT[artifact.type];
  const Icon = tint.icon;
  return (
    <Link
      to="/preview/library/$artifact"
      params={{ artifact: artifact.id }}
      className={cn(
        "group block overflow-hidden rounded-2xl bg-vs-bg-1 vs-card-in",
        "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
        "transition-shadow vs-press",
        "hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.08)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
      style={{ animationDelay: `${index * 60 + 160}ms` }}
    >
      <div className="aspect-[4/3] bg-vs-bg-2/60 p-4 shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)]">
        {artifact.pages[0]?.html ? (
          <ArtifactPageFrame
            html={artifact.pages[0].html}
            title={`${artifact.title} cover preview`}
            className="mx-auto h-full max-w-[210px] rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.10)]"
          />
        ) : (
          <div
            className={cn(
              "mx-auto flex h-full max-w-[210px] flex-col rounded-lg p-4 text-vs-fg-4",
              "shadow-[0_4px_12px_rgba(0,0,0,0.10),0_0_0_1px_rgba(0,0,0,0.05)]",
              "bg-vs-bg-1",
            )}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-vs-fg-2">
              {artifact.pages[0]?.kicker}
            </p>
            <p className="mt-3 text-lg font-semibold leading-5 text-vs-fg-4">
              {artifact.pages[0]?.title}
            </p>
            <p className="mt-3 line-clamp-5 text-[11px] leading-4 text-vs-fg-3">
              {artifact.pages[0]?.body}
            </p>
          </div>
        )}
      </div>
      <div className="flex items-start gap-3 p-4">
        <span
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl ring-1",
            tint.bg,
            tint.fg,
            tint.ring,
          )}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-vs-fg-4">{artifact.title}</p>
            {artifact.favourite ? (
              <Star
                size={12}
                aria-hidden
                className="shrink-0 fill-vs-amber-4 text-vs-amber-4"
              />
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-vs-fg-3">
            {artifact.typeLabel} · {artifact.updatedLabel}
          </p>
        </div>
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-xl text-vs-fg-2 transition-colors group-hover:text-vs-fg-4"
        >
          <MoreHorizontal size={16} />
        </span>
      </div>
    </Link>
  );
}

function LibraryEmpty({ filter, query }: { filter: LibraryFilter; query: string }): ReactNode {
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
        <span
          aria-hidden
          className="grid size-12 place-items-center rounded-2xl bg-vs-bg-2 text-vs-fg-3"
        >
          <PartyPopper size={22} strokeWidth={1.5} />
        </span>
        <p className="mt-3 text-sm font-medium text-vs-fg-4">{title}</p>
        <p className="mt-1 max-w-[28rem] text-[12.5px] leading-relaxed text-vs-fg-3">
          {description}
        </p>
      </div>
    </div>
  );
}
