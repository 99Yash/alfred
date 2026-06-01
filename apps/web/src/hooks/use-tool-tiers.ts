import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";

export interface RiskTierCounts {
  no_risk: number;
  low: number;
  medium: number;
  high: number;
}

type TierMap = Readonly<Record<string, RiskTierCounts>>;

function isRiskTierCounts(value: unknown): value is RiskTierCounts {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.no_risk === "number" &&
    typeof record.low === "number" &&
    typeof record.medium === "number" &&
    typeof record.high === "number"
  );
}

function parseTierMap(value: unknown): TierMap {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, RiskTierCounts> = {};
  for (const [slug, counts] of Object.entries(value)) {
    if (isRiskTierCounts(counts)) out[slug] = counts;
  }
  return out;
}

/**
 * Per-integration tool-tier counts from the server registry. The web
 * bundle can't import the tool registry (server-only), so the detail
 * page reads counts from `/api/integrations/tool-tiers`. Static after
 * boot, so a long stale time is fine. Returns `{}` on any error so
 * callers render the honest "no tools" branch instead of throwing.
 */
export function useToolTiers(): TierMap {
  const { data } = useQuery<TierMap>({
    queryKey: ["integrations", "tool-tiers"],
    queryFn: async () => {
      const res = await client.api.integrations["tool-tiers"].get();
      if (res.error || !res.data) return {};
      return parseTierMap(res.data.tiers);
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  return data ?? {};
}

/** Tier counts for one integration slug, or null if it has no tools. */
export function useIntegrationTierCounts(slug: string): RiskTierCounts | null {
  const tiers = useToolTiers();
  const counts = tiers[slug];
  if (!counts) return null;
  const total = counts.no_risk + counts.low + counts.medium + counts.high;
  return total > 0 ? counts : null;
}
