import { isRecord, type RiskTierCounts } from "@alfred/contracts";
import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";

type TierMap = ReadonlyMap<string, RiskTierCounts>;

function isRiskTierCounts(value: unknown): value is RiskTierCounts {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    typeof record.no_risk === "number" &&
    typeof record.low === "number" &&
    typeof record.medium === "number" &&
    typeof record.high === "number"
  );
}

function parseTierMap(value: unknown): TierMap {
  const out = new Map<string, RiskTierCounts>();
  if (!isRecord(value)) return out;
  for (const [slug, counts] of Object.entries(value)) {
    if (isRiskTierCounts(counts)) out.set(slug, counts);
  }
  return out;
}

function useToolTiers(): TierMap {
  const { data } = useQuery<TierMap>({
    queryKey: ["integrations", "tool-tiers"],
    queryFn: async () => {
      const res = await client.api.integrations["tool-tiers"].get();
      if (res.error || !res.data) return new Map();
      return parseTierMap(res.data.tiers);
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  return data ?? new Map();
}

export function useIntegrationTierCounts(slug: string): RiskTierCounts | null {
  const tiers = useToolTiers();
  const counts = tiers.get(slug);
  if (!counts) return null;
  const total = counts.no_risk + counts.low + counts.medium + counts.high;
  return total > 0 ? counts : null;
}
