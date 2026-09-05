import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from "@alfred/contracts";
import {
  BarChart3,
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
import type { ComponentType } from "react";
import type { AppTint } from "~/lib/tints";

export const SECTIONS = [
  { id: "user", label: "User", icon: User },
  { id: "features", label: "Features", icon: Sparkles },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "preferences", label: "Preferences", icon: Sliders },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}>;

/** A settings sidebar section, inferred from the `SECTIONS` registry. */
export type SectionDef = (typeof SECTIONS)[number];
export type SectionId = SectionDef["id"];

export interface BackgroundAgentDef {
  id: string;
  label: string;
  helper: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  tint: AppTint;
  /**
   * `user_preferences` key this switch writes. The switch reads its state via
   * `isOn(prefKey)`, which applies the per-key default from
   * `FEATURE_FLAG_DEFAULTS` when no row exists (UNSET = ON for the original
   * agents, OFF for reply drafting). Omitted for agents that have no flag yet —
   * those render as disabled "Coming soon" rows.
   */
  prefKey?: FeatureFlagKey | undefined;
  /** Not built yet — row is shown for parity but switched off and disabled. */
  comingSoon?: boolean | undefined;
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
    // The flag and the gate exist (#243); the composer does not (#237). The
    // switch stays disabled until a run can actually stage a draft.
    prefKey: FEATURE_FLAG_KEYS.replyDrafting,
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
