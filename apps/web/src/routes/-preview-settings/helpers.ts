import {
  Gift,
  ListChecks,
  PencilLine,
  Sliders,
  Sparkles,
  Sunrise,
  Sunset,
  Tag,
  User,
  Users2,
} from "lucide-react";
import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from "@alfred/contracts";
import type { ComponentType } from "react";

export type SectionId = "user" | "features" | "preferences" | "referrals";

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export const SECTIONS: ReadonlyArray<SectionDef> = [
  { id: "user", label: "User", icon: User },
  { id: "features", label: "Features", icon: Sparkles },
  { id: "preferences", label: "Preferences", icon: Sliders },
  { id: "referrals", label: "Referrals", icon: Gift },
];

export interface BackgroundAgentDef {
  id: string;
  label: string;
  helper: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  tint: "purple" | "amber" | "sky" | "green" | "pink" | "orange";
  /**
   * `user_preferences` key this switch writes. The switch reads its state via
   * `isOn(prefKey)`, which defaults to ON when no row exists (UNSET = ON).
   * Omitted for agents that don't exist yet — those render as disabled
   * "Coming soon" rows.
   */
  prefKey?: FeatureFlagKey;
  /** Not built yet — row is shown for parity but switched off and disabled. */
  comingSoon?: boolean;
}

export const BACKGROUND_AGENTS: ReadonlyArray<BackgroundAgentDef> = [
  {
    id: "action-items",
    label: "Action items",
    helper: "Pulls action items from your apps and flags what's urgent.",
    icon: ListChecks,
    tint: "purple",
    prefKey: FEATURE_FLAG_KEYS.actionItems,
  },
  {
    id: "evening-recap",
    label: "Evening recap",
    helper: "A daily summary of what got done and what's still open.",
    icon: Sunset,
    tint: "orange",
    prefKey: FEATURE_FLAG_KEYS.eveningRecap,
  },
  {
    id: "morning-briefing",
    label: "Morning briefing",
    helper: "Your schedule, tasks, and key updates — delivered each morning.",
    icon: Sunrise,
    tint: "amber",
    prefKey: FEATURE_FLAG_KEYS.morningBriefing,
  },
  {
    id: "email-tagging",
    label: "Email tagging",
    helper: "Tags every inbound email so you know what needs action.",
    icon: Tag,
    tint: "green",
    prefKey: FEATURE_FLAG_KEYS.emailTagging,
  },
  {
    id: "email-auto-drafting",
    label: "Email auto-drafting",
    helper: "Drafts replies in your tone so you can review and send.",
    icon: PencilLine,
    tint: "sky",
    comingSoon: true,
  },
  {
    id: "meeting-prep",
    label: "Meeting prep",
    helper: "Briefs you on attendees, talking points, and past context.",
    icon: Users2,
    tint: "pink",
    comingSoon: true,
  },
];

export const TINT_TILE: Record<BackgroundAgentDef["tint"], string> = {
  purple: "bg-app-purple-1 text-app-purple-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  sky: "bg-app-sky-1 text-app-sky-4",
  green: "bg-app-green-1 text-app-green-4",
  pink: "bg-app-pink-1 text-app-pink-4",
  orange: "bg-app-orange-1 text-app-orange-4",
};
