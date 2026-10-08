import { Eye, Zap } from "lucide-react";
import type { ComponentType } from "react";

export interface ModeOption {
  /** Autonomy (Autopilot) or gated (Review). */
  autonomy: boolean;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number | string; className?: string }>;
}

const REVIEW_OPTION: ModeOption = {
  autonomy: false,
  label: "Review",
  description: "Alfred pauses for your approval before acting.",
  Icon: Eye,
};

const AUTOPILOT_OPTION: ModeOption = {
  autonomy: true,
  label: "Autopilot",
  description: "Alfred acts without pausing for approval.",
  Icon: Zap,
};

/** Shared with the "..." menu, as with {@link TIER_OPTIONS}. */
export const MODE_OPTIONS: ReadonlyArray<ModeOption> = [REVIEW_OPTION, AUTOPILOT_OPTION];

export function modeOption(autonomy: boolean): ModeOption {
  return autonomy ? AUTOPILOT_OPTION : REVIEW_OPTION;
}
