import { Eye, Zap } from "lucide-react";
import type { ComponentType } from "react";

/** One autonomy mode, as the user reads it. */
export interface ModeOption {
  /** True = autonomy (Autopilot); false = gated (Review). */
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

/**
 * The two autonomy modes, as the user reads them. They sit here for the same
 * two reasons as {@link TIER_OPTIONS}: the chat header's "..." menu writes this
 * exact state, so it reads these labels rather than re-spelling them, and a
 * component file that also exports a data table loses React Fast Refresh.
 */
export const MODE_OPTIONS: ReadonlyArray<ModeOption> = [REVIEW_OPTION, AUTOPILOT_OPTION];

/** The option an autonomy flag selects. */
export function modeOption(autonomy: boolean): ModeOption {
  return autonomy ? AUTOPILOT_OPTION : REVIEW_OPTION;
}
