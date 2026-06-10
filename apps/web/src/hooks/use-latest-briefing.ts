import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";

/**
 * Most recent composed briefing for the signed-in user. Drives the rail
 * footer CTA: when null, the CTA reads "Morning briefing · No briefing
 * yet"; when present, the CTA labels itself with the briefing's slot +
 * local-date.
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
    // While an on-demand briefing is composing, poll so the chip flips from
    // "Composing…" to the live briefing as soon as the terminal row lands.
    refetchInterval: opts?.poll ? 10_000 : false,
  });
}
