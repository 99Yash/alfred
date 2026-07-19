import type {
  UsageActivityRun,
  UsageRunCategory,
  UsageSortDir,
  UsageSortField,
} from "@alfred/contracts";
import { USAGE_ACTIVITY_DEFAULT_PAGE_SIZE } from "@alfred/contracts";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { modelLabel, providerOf } from "~/components/provider-marks";
import { AppButton, AppCard, AppSelect } from "~/components/ui/v2";
import { cn } from "~/lib/utils";
import { CATEGORY_LABELS, CATEGORY_TILE } from "./constants";
import { formatCost, formatDateTime, formatTokens } from "./format";
import { useUsageActivity } from "./use-usage";

const PAGE_SIZE_OPTIONS = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
];

/** A model chip: provider mark (brand tint) + short label. */
function ModelChip({ model }: { model: string }) {
  const provider = providerOf(model);
  const Icon = provider?.Icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-app-bg-a2 px-1.5 py-0.5 text-[11px] text-app-fg-3">
      {Icon ? (
        <Icon className="size-3 shrink-0" style={{ color: provider?.tint }} aria-hidden />
      ) : null}
      <span className="font-medium">{modelLabel(model)}</span>
    </span>
  );
}

/** Category pill matching the cards' tint. */
function CategoryPill({ category, label }: { category: UsageRunCategory; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        CATEGORY_TILE[category],
      )}
      title={CATEGORY_LABELS[category]}
    >
      {label}
    </span>
  );
}

function SortHeader({
  label,
  field,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  field: UsageSortField;
  active: boolean;
  dir: UsageSortDir;
  onSort: (field: UsageSortField) => void;
  align?: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium text-app-fg-3 transition-colors hover:text-app-fg-4",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      {active ? (
        dir === "asc" ? (
          <ArrowUp size={12} aria-hidden />
        ) : (
          <ArrowDown size={12} aria-hidden />
        )
      ) : null}
    </button>
  );
}

interface ActivityTableProps {
  start: string;
  end: string;
  categories: ReadonlyArray<UsageRunCategory>;
}

/**
 * Per-run activity table. Rows are agent runs (grouped from `api_call_log`),
 * filtered by the shared category selection, sorted by recency or cost, and
 * paginated server-side. Page resets whenever the filter or window changes
 * (the documented "adjust state during render on prop change" pattern).
 */
export function ActivityTable({ start, end, categories }: ActivityTableProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(USAGE_ACTIVITY_DEFAULT_PAGE_SIZE);
  const [sortField, setSortField] = useState<UsageSortField>("createdAt");
  const [sortDir, setSortDir] = useState<UsageSortDir>("desc");

  // Reset to page 1 when the filter or window changes, without an effect.
  const resetKey = `${start}|${end}|${categories.toSorted().join(",")}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setPage(1);
  }

  const { data, isLoading, isError, isPlaceholderData } = useUsageActivity({
    start,
    end,
    page,
    pageSize,
    categories,
    sortField,
    sortDir,
  });

  const onSort = (field: UsageSortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(1);
  };

  const runs: ReadonlyArray<UsageActivityRun> = data?.runs ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  return (
    <AppCard padded={false}>
      <div className="flex items-center justify-between gap-3 border-b border-app-bg-2 px-5 py-3">
        <p className="text-sm font-medium text-app-fg-4">Activity</p>
        {categories.length > 0 ? (
          <span className="text-xs text-app-fg-3">
            Filtered · {categories.length} {categories.length === 1 ? "category" : "categories"}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-app-bg-2 text-left">
              <th className="px-5 py-2.5 font-normal">
                <SortHeader
                  label="Date & time"
                  field="createdAt"
                  active={sortField === "createdAt"}
                  dir={sortDir}
                  onSort={onSort}
                />
              </th>
              <th className="px-3 py-2.5 text-xs font-medium text-app-fg-3">Category</th>
              <th className="px-3 py-2.5 text-xs font-medium text-app-fg-3">Models</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-app-fg-3">Tokens</th>
              <th className="px-5 py-2.5 text-right font-normal">
                <SortHeader
                  label="Cost"
                  field="costUsd"
                  active={sortField === "costUsd"}
                  dir={sortDir}
                  onSort={onSort}
                  align="right"
                />
              </th>
            </tr>
          </thead>
          <tbody className={cn(isPlaceholderData && "opacity-60 transition-opacity")}>
            {isLoading ? (
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-app-bg-2 last:border-0">
                  <td colSpan={5} className="px-5 py-3">
                    <span className="block h-4 w-full animate-pulse rounded bg-app-bg-2" />
                  </td>
                </tr>
              ))
            ) : isError ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-sm text-app-fg-3">
                  Couldn&apos;t load activity. Try again shortly.
                </td>
              </tr>
            ) : runs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-sm text-app-fg-3">
                  No runs in this window.
                </td>
              </tr>
            ) : (
              runs.map((run) => {
                const tokens = run.inputTokens + run.outputTokens;
                return (
                  <tr key={run.runId} className="border-b border-app-bg-2 last:border-0">
                    <td className="px-5 py-3 whitespace-nowrap text-app-fg-3 tabular-nums">
                      {formatDateTime(run.createdAt)}
                    </td>
                    <td className="p-3">
                      <CategoryPill category={run.category} label={run.label} />
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap items-center gap-1">
                        {run.models.slice(0, 3).map((m) => (
                          <ModelChip key={m.model} model={m.model} />
                        ))}
                        {run.models.length > 3 ? (
                          <span className="text-[11px] text-app-fg-2">
                            +{run.models.length - 3}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-3 text-right font-mono text-xs whitespace-nowrap text-app-fg-3 tabular-nums">
                      {formatTokens(tokens)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs font-medium whitespace-nowrap text-app-fg-4 tabular-nums">
                      {formatCost(run.costUsd)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-app-bg-2 px-5 py-3">
        <div className="flex items-center gap-2 text-xs text-app-fg-3">
          <span>Rows</span>
          <AppSelect
            value={String(pageSize)}
            onChange={(v) => {
              setPageSize(Number(v) || USAGE_ACTIVITY_DEFAULT_PAGE_SIZE);
              setPage(1);
            }}
            options={PAGE_SIZE_OPTIONS}
            className="w-20"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-app-fg-3 tabular-nums">
          <span>
            {rangeStart}–{rangeEnd} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <AppButton
              size="sm"
              variant="ghost"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft size={15} aria-hidden />
            </AppButton>
            <AppButton
              size="sm"
              variant="ghost"
              aria-label="Next page"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              <ChevronRight size={15} aria-hidden />
            </AppButton>
          </div>
        </div>
      </div>
    </AppCard>
  );
}
