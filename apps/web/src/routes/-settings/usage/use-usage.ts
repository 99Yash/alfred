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
 * Settings → Usage queries. The window is ISO strings, so the query key is a
 * stable primitive. The server already coerces aggregates to numbers.
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
  const categoriesKey = args.categories.toSorted().join(",");

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
          ...(categoriesKey ? { categories: categoriesKey } : {}),
          sortField: args.sortField,
          sortDir: args.sortDir,
        },
      });

      if (res.error || !res.data) throw new Error("Failed to load usage activity");

      return res.data;
    },
    // Keep the current page while the next one loads.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
