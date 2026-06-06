import type { ToolRiskTier } from "@alfred/contracts";
import { AppPill } from "~/components/ui/v2";

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
  return <AppPill tone={TONE[riskTier]}>{LABEL[riskTier]}</AppPill>;
}
