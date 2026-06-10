import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";

/**
 * Most recent same-day briefing row for the signed-in user. Sent/suppressed
 * rows drive the rail footer CTA; failed rows are still returned so a manual
 * run can stop polling and clear its "Composing…" state.
 *
 * Errors collapse to `null` so the footer can fall back to its empty
 * state without exploding the rail.
 */
export interface LatestBriefingSummary {
  id: string;
  slot: string;
  briefingDate: string;
  runAt: string;
  subject: string | null;
  status: string;
}

export function useLatestBriefing(opts?: { poll?: boolean }) {
  return useQuery<LatestBriefingSummary | null>({
    queryKey: ["me", "briefings", "latest"],
    queryFn: async () => {
      const res = await client.api.me.briefings.latest.get();
      if (res.error || !res.data) return null;
      return res.data.briefing;
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    // While an on-demand briefing is composing, poll so the chip flips to the
    // live briefing or clears itself if the run fails.
    refetchInterval: opts?.poll ? 10_000 : false,
  });
}
