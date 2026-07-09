import { useQuery } from "@tanstack/react-query";
import { client, type EdenData } from "~/lib/eden";

/**
 * Most recent same-day briefing row for the signed-in user. Sent/suppressed
 * rows drive the rail footer CTA; failed rows are still returned so a manual
 * run can stop polling and clear its "Composing…" state.
 *
 * Errors collapse to `null` so the footer can fall back to its empty
 * state without exploding the rail. Derived from the route's `briefing`
 * payload so it can't drift from the server DTO (code-style §1).
 */
export type LatestBriefingSummary = NonNullable<
  EdenData<typeof client.api.me.briefings.latest.get>["briefing"]
>;

/**
 * Normalize a `date` column value to a `YYYY-MM-DD` key. Eden Treaty revives
 * ISO-ish strings in responses into `Date` objects, so `briefingDate` — typed
 * as `string` but a midnight-UTC `Date` at runtime — must be flattened back to
 * its calendar-date string. Otherwise the rail's `/briefings/$date` link
 * stringifies the `Date` via `toString()` ("Thu Jun 11 2026 …") and 404s. UTC
 * getters recover the original date (the value parses as midnight UTC).
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
    // While an on-demand briefing is composing, poll so the chip flips to the
    // live briefing or clears itself if the run fails.
    refetchInterval: opts?.poll ? 10_000 : false,
  });
}
