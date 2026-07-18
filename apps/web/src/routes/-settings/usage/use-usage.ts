import type {
  UsageActivityResult,
  UsageBreakdown,
  UsageRunCategory,
  UsageSortDir,
  UsageSortField,
  UsageSummary,
} from "@alfred/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";

/**
 * Settings → Usage data hooks. Each wraps a `GET /api/me/usage/*` Eden call in
 * React Query. The window is passed as ISO strings so the query key is a stable
 * primitive (a `Date` object would be a new reference every render and thrash
 * the cache). All three read paths tolerate an empty backend — the components
 * render honest empty states.
 *
 * The server already coerces every aggregate to a finite number (Postgres
 * returns `numeric`/`sum` as strings; `usage-service` folds them via `num`), so
 * the responses arrive shaped exactly as the `@alfred/contracts` types declare.
 * We return Eden's typed payload directly rather than re-coercing field by field
 * — the only date fields here are fed straight to `new Date()` downstream, which
 * tolerates Eden's date-string revival without a normalization pass.
 */

interface UsageWindow {
  /** ISO instant, inclusive. */
  start: string;
  /** ISO instant, exclusive. */
  end: string;
}

export function useUsageSummary(window: UsageWindow) {
  return useQuery<UsageSummary>({
    queryKey: ["usage", "summary", window.start, window.end],
    queryFn: async () => {
      const res = await client.api.me.usage.summary.get({
        query: { start: window.start, end: window.end },
      });
      if (res.error || !res.data) throw new Error("Failed to load usage summary");
      return res.data;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUsageBreakdown(window: UsageWindow) {
  return useQuery<UsageBreakdown>({
    queryKey: ["usage", "breakdown", window.start, window.end],
    queryFn: async () => {
      const res = await client.api.me.usage.breakdown.get({
        query: { start: window.start, end: window.end },
      });
      if (res.error || !res.data) throw new Error("Failed to load usage breakdown");
      return res.data;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

interface ActivityArgs extends UsageWindow {
  page: number;
  pageSize: number;
  categories: ReadonlyArray<UsageRunCategory>;
  sortField: UsageSortField;
  sortDir: UsageSortDir;
}

export function useUsageActivity(args: ActivityArgs) {
  const categoriesKey = [...args.categories].sort().join(",");
  return useQuery<UsageActivityResult>({
    queryKey: [
      "usage",
      "activity",
      args.start,
      args.end,
      args.page,
      args.pageSize,
      categoriesKey,
      args.sortField,
      args.sortDir,
    ],
    queryFn: async () => {
      const res = await client.api.me.usage.activity.get({
        query: {
          start: args.start,
          end: args.end,
          page: args.page,
          pageSize: args.pageSize,
          categories: categoriesKey || undefined,
          sortField: args.sortField,
          sortDir: args.sortDir,
        },
      });
      if (res.error || !res.data) throw new Error("Failed to load usage activity");
      return res.data;
    },
    // Keep the current page visible while the next page / re-sort loads.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
