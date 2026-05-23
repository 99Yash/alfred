import {
  BadgeDollarSign,
  Gift,
  ListChecks,
  PackageCheck,
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

export type SectionId = "user" | "billing" | "plan" | "features" | "preferences" | "referrals";

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export const SECTIONS: ReadonlyArray<SectionDef> = [
  { id: "user", label: "User", icon: User },
  { id: "billing", label: "Billing", icon: BadgeDollarSign },
  { id: "plan", label: "Plan", icon: PackageCheck },
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
  defaultOn: boolean;
}

export const BACKGROUND_AGENTS: ReadonlyArray<BackgroundAgentDef> = [
  { id: "action-items", label: "Action items", helper: "Pulls action items from your apps and flags what's urgent.", icon: ListChecks, tint: "purple", defaultOn: true },
  { id: "evening-recap", label: "Evening recap", helper: "A daily summary of what got done and what's still open.", icon: Sunset, tint: "orange", defaultOn: false },
  { id: "morning-briefing", label: "Morning briefing", helper: "Your schedule, tasks, and key updates — delivered each morning.", icon: Sunrise, tint: "amber", defaultOn: true },
  { id: "email-tagging", label: "Email tagging", helper: "Tags every inbound email so you know what needs action.", icon: Tag, tint: "green", defaultOn: true },
  { id: "email-auto-drafting", label: "Email auto-drafting", helper: "Drafts replies in your tone so you can review and send.", icon: PencilLine, tint: "sky", defaultOn: false },
  { id: "meeting-prep", label: "Meeting prep", helper: "Briefs you on attendees, talking points, and past context.", icon: Users2, tint: "pink", defaultOn: false },
];

export const TINT_TILE: Record<BackgroundAgentDef["tint"], string> = {
  purple: "bg-vs-purple-1 text-vs-purple-4",
  amber: "bg-vs-amber-1 text-vs-amber-4",
  sky: "bg-vs-sky-1 text-vs-sky-4",
  green: "bg-vs-green-1 text-vs-green-4",
  pink: "bg-vs-pink-1 text-vs-pink-4",
  orange: "bg-vs-orange-1 text-vs-orange-4",
};
