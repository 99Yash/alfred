import type { UsageRunCategory } from "@alfred/contracts";
import { AppCard } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { CATEGORY_LABELS, CATEGORY_TILE } from "./constants";
import { formatCost, formatTokens } from "./format";
import { useUsageBreakdown } from "./use-usage";

interface CategoryCardsProps {
  start: string;
  end: string;
  selected: ReadonlyArray<UsageRunCategory>;
  onToggle: (category: UsageRunCategory) => void;
}

/**
 * Per-category spend cards. Each card is a toggle: clicking it filters the
 * activity table below to that category (the cards ARE the table's filter
 * control). Sorted by spend, so the biggest cost driver leads.
 */
export function CategoryCards({ start, end, selected, onToggle }: CategoryCardsProps) {
  const { data, isLoading } = useUsageBreakdown({ start, end });
  const selectedSet = new Set(selected);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-app-bg-2" aria-hidden />
        ))}
      </div>
    );
  }

  const categories = data?.categories ?? [];
  if (categories.length === 0) {
    // Empty state rather than null: the parent renders the "By category" header
    // above this, so returning null would leave that header dangling over
    // nothing on an empty window.
    return (
      <AppCard>
        <p className="text-sm text-app-fg-3">No categorized spend in this window.</p>
      </AppCard>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {categories.map((c) => {
        const active = selectedSet.has(c.category);
        return (
          <AppCard
            key={c.category}
            padded={false}
            interactive
            role="button"
            tabIndex={0}
            aria-pressed={active}
            onClick={() => onToggle(c.category)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle(c.category);
              }
            }}
            className={cn(
              "cursor-pointer p-4 transition-shadow",
              active && "ring-2 ring-app-purple-4 ring-offset-1 ring-offset-app-bg-1",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                  CATEGORY_TILE[c.category],
                )}
              >
                {CATEGORY_LABELS[c.category]}
              </span>
              <span className="text-[11px] text-app-fg-2 tabular-nums">
                {c.runs.toLocaleString()} {c.runs === 1 ? "run" : "runs"}
              </span>
            </div>
            <p className="mt-3 text-base font-semibold text-app-fg-4 tabular-nums">
              {formatCost(c.costUsd)}
            </p>
            <p className="mt-0.5 text-[11px] text-app-fg-3 tabular-nums">
              {formatTokens(c.tokens)} tokens
            </p>
          </AppCard>
        );
      })}
    </div>
  );
}
