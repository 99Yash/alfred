import {
  COLD_START_WORKFLOW_SLUG,
  DAILY_BRIEFING_WORKFLOW_SLUG,
  eventTriggerPhrase,
  REPLY_DRAFTING_WORKFLOW_SLUG,
  TRIAGE_WORKFLOW_SLUG,
} from "@alfred/contracts";
import type { SyncedWorkflow } from "@alfred/sync";
import type { ComponentType } from "react";
import {
  CalendarClock,
  CheckCircle2,
  type LucideIcon,
  Mail,
  PencilLine,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { BriefingHero } from "./briefing-hero";
import { ResearchHero } from "./research-hero";
import { TriageHero } from "./triage-hero";

/** Tints cycled by slug hash for workflows without their own art. */
const FALLBACK_TINTS = ["violet", "emerald", "amber"] as const;

export type WorkflowTint = (typeof FALLBACK_TINTS)[number];

type WorkflowHero = ComponentType<{ accent: string }>;

/** Art for the builtin workflows, keyed on the slugs the server registers. */
const KNOWN_PRESENTATION = new Map<
  string,
  { icon: LucideIcon; tint: WorkflowTint; hero?: WorkflowHero }
>([
  [DAILY_BRIEFING_WORKFLOW_SLUG, { icon: Mail, tint: "violet", hero: BriefingHero }],
  [TRIAGE_WORKFLOW_SLUG, { icon: CheckCircle2, tint: "emerald", hero: TriageHero }],
  [COLD_START_WORKFLOW_SLUG, { icon: CalendarClock, tint: "amber", hero: ResearchHero }],
  [REPLY_DRAFTING_WORKFLOW_SLUG, { icon: PencilLine, tint: "emerald" }],
]);

function hashSlug(slug: string): number {
  let h = 0;

  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;

  return h;
}

/** The card art: a builtin's own icon, tint, and hero, else a fallback picked from the slug and trigger. */
export function presentationFor(w: SyncedWorkflow) {
  const known = KNOWN_PRESENTATION.get(w.slug);

  if (known) return known;
  const tint = FALLBACK_TINTS[hashSlug(w.slug) % FALLBACK_TINTS.length] ?? "violet";

  const icon =
    w.trigger.kind === "cron" ? CalendarClock : w.trigger.kind === "event" ? Zap : WorkflowIcon;

  return { icon, tint, hero: undefined };
}

function describeCron(schedule: string, timezone?: string): string {
  const tzSuffix = timezone ? ` (${timezone})` : "";
  const parts = schedule.trim().split(/\s+/);

  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;

    if (
      min !== undefined &&
      hour !== undefined &&
      dom === "*" &&
      mon === "*" &&
      dow === "*" &&
      /^\d+$/.test(min) &&
      /^\d+$/.test(hour)
    ) {
      return `Every day at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}${tzSuffix}`;
    }
  }

  return `On schedule (${schedule})${tzSuffix}`;
}

/** The card's cadence line for a trigger. */
export function describeCadence(trigger: SyncedWorkflow["trigger"]): string {
  if (trigger.kind === "cron") return describeCron(trigger.schedule, trigger.timezone);

  if (trigger.kind === "event") return `On ${eventTriggerPhrase(trigger)}`;

  if (trigger.kind === "on_signal") return "On signal";

  return "Manual";
}
