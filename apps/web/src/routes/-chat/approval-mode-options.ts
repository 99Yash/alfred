import { Eye, ShieldOff, Zap } from "lucide-react";
import type { ComponentType } from "react";
import type { ChatApprovalMode } from "@alfred/sync";

export interface ModeOption {
  value: ChatApprovalMode;
  label: string;
  description: string;
  Icon: ComponentType<{ size?: number | string; className?: string }>;
}

const REVIEW_OPTION: ModeOption = {
  value: "review",
  label: "Review",
  description: "Alfred pauses for your approval before acting.",
  Icon: Eye,
};

const AUTO_OPTION: ModeOption = {
  value: "auto",
  label: "Auto",
  description: "Alfred follows your integration rules. Risky actions still ask.",
  Icon: Zap,
};

const FULL_OPTION: ModeOption = {
  value: "full",
  label: "Full autonomy",
  description: "This chat never asks. Sends, invites, and deploys run at once.",
  Icon: ShieldOff,
};

/** Shared with the "..." menu, as with {@link TIER_OPTIONS}. */
export const MODE_OPTIONS: ReadonlyArray<ModeOption> = [REVIEW_OPTION, AUTO_OPTION, FULL_OPTION];

export function modeOption(mode: ChatApprovalMode): ModeOption {
  if (mode === "full") return FULL_OPTION;

  return mode === "auto" ? AUTO_OPTION : REVIEW_OPTION;
}
