import { VsPill } from "~/components/ui/visitors";
import type { RiskTier } from "./types";

export function RiskPill({ riskTier }: { riskTier: RiskTier }) {
  const tone = riskTier === "high" ? "red" : riskTier === "medium" ? "amber" : "green";
  return <VsPill tone={tone}>{riskTier}</VsPill>;
}
