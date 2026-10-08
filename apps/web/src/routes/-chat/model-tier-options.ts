import type { ChatModelTier } from "@alfred/contracts";

export interface TierOption {
  value: ChatModelTier;
  label: string;
  description: string;
}

const STANDARD_OPTION: TierOption = {
  value: "standard",
  label: "Alfred",
  description: "Great for almost everything",
};

const DEEP_OPTION: TierOption = {
  value: "deep",
  label: "Alfred Pro",
  description: "Flagship reasoning for complex tasks",
};

/**
 * Shared with the "..." menu so both surfaces name the tiers the same.
 * Not in the component file, which would lose Fast Refresh.
 */
export const TIER_OPTIONS: ReadonlyArray<TierOption> = [STANDARD_OPTION, DEEP_OPTION];

export function tierOption(value: ChatModelTier): TierOption {
  return value === "deep" ? DEEP_OPTION : STANDARD_OPTION;
}
