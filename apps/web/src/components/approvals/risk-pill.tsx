import type { ToolRiskTier } from "@alfred/contracts";
import { VsPill } from "~/components/ui/visitors";

const TONE: Record<ToolRiskTier, "red" | "amber" | "green" | undefined> = {
  high: "red",
  medium: "amber",
  low: "green",
  no_risk: undefined,
};

const LABEL: Record<ToolRiskTier, string> = {
  high: "high",
  medium: "medium",
  low: "low",
  no_risk: "no risk",
};

export function RiskPill({ riskTier }: { riskTier: ToolRiskTier }) {
  return <VsPill tone={TONE[riskTier]}>{LABEL[riskTier]}</VsPill>;
}
