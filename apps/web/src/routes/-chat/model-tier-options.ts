import type { ChatModelTier } from "@alfred/contracts";

/** One model tier, as the user reads it. */
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
 * The two tiers, as the user reads them.
 *
 * They sit in their own module for two reasons. The chat header's "..." menu
 * offers the same choice as the composer's picker, and a second spelling of
 * "Alfred" / "Alfred Pro" is how two surfaces that write the same state end up
 * disagreeing about what that state is called. And a component file that also
 * exports a data table loses React Fast Refresh, so editing the picker would
 * force a full reload instead of a hot swap.
 */
export const TIER_OPTIONS: ReadonlyArray<TierOption> = [STANDARD_OPTION, DEEP_OPTION];

/** The option a tier value selects. */
export function tierOption(value: ChatModelTier): TierOption {
  return value === "deep" ? DEEP_OPTION : STANDARD_OPTION;
}
