import type { ToolRiskTier } from "@alfred/contracts";
import { cn } from "~/lib/utils";
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

/**
 * Static (non-interactive) tier chip for embedding inside interactive rows —
 * e.g. the approval card's accordion trigger, where a nested `<button>`
 * (AppPill) would be invalid HTML. Same tone mapping as {@link RiskPill}.
 */
export function RiskChip({ riskTier }: { riskTier: ToolRiskTier }) {
  const tone = TONE[riskTier];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap",
        tone
          ? {
              red: "bg-app-red-1 text-app-red-4",
              amber: "bg-app-amber-1 text-app-amber-4",
              green: "bg-app-green-1 text-app-green-4",
            }[tone]
          : "bg-app-bg-1 text-app-fg-3",
      )}
    >
      {LABEL[riskTier]}
    </span>
  );
}
