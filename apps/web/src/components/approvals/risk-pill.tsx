import type { ToolRiskTier } from "@alfred/contracts";
import { AppPill } from "~/components/ui/v2";

const TONE = {
  high: "red",
  medium: "amber",
  low: "green",
  no_risk: undefined,
} satisfies Record<ToolRiskTier, "red" | "amber" | "green" | undefined>;

const LABEL = {
  high: "high",
  medium: "medium",
  low: "low",
  no_risk: "no risk",
} satisfies Record<ToolRiskTier, string>;

export function RiskPill({ riskTier }: { riskTier: ToolRiskTier }) {
  return <AppPill tone={TONE[riskTier]}>{LABEL[riskTier]}</AppPill>;
}
