import { useQuery } from "@tanstack/react-query";
import { client, type EdenData } from "~/lib/eden";

/**
 * Latest same-day briefing. Failed rows are included so a manual run can stop polling.
 * Errors become `null`, so the footer shows its empty state.
 */
export type LatestBriefingSummary = NonNullable<
  EdenData<typeof client.api.me.briefings.latest.get>["briefing"]
>;

/**
 * Eden revives `briefingDate` into a midnight-UTC `Date`. Flatten it back to
 * `YYYY-MM-DD` with UTC getters, or the `/briefings/$date` link 404s.
 */
function toDateKey(value: string | Date): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");

    return `${y}-${m}-${d}`;
  }

  return value;
}

export function useLatestBriefing(opts?: { poll?: boolean }) {
  return useQuery<LatestBriefingSummary | null>({
    queryKey: ["me", "briefings", "latest"],
    queryFn: async () => {
      const res = await client.api.me.briefings.latest.get();

      if (res.error || !res.data) return null;
      const b = res.data.briefing;

      return b ? { ...b, briefingDate: toDateKey(b.briefingDate) } : null;
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    // Poll while composing, so the chip flips to the briefing or clears on failure.
    refetchInterval: opts?.poll ? 10_000 : false,
  });
}
