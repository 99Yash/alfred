import {
  COLD_START_WORKFLOW_SLUG,
  DAILY_BRIEFING_WORKFLOW_SLUG,
  eventTriggerPhrase,
  integrationDisplayName,
  REPLY_DRAFTING_WORKFLOW_SLUG,
  TRIAGE_WORKFLOW_SLUG,
} from "@alfred/contracts";
import type { SyncedWorkflow } from "@alfred/sync";
import type { ComponentType } from "react";
import { lowerFirst } from "~/lib/strings";
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

type WorkflowTint = (typeof FALLBACK_TINTS)[number];

type WorkflowHero = ComponentType<{ accent: string }>;

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  cadence: string;
  icon: LucideIcon;
  tint: WorkflowTint;
  hero: WorkflowHero | undefined;
  status: "active" | "draft";
  prompt: string;
  trigger: {
    type: "Schedule" | "Event";
    summary: string;
  };
  integrations: ReadonlyArray<string>;
};

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

function presentationFor(w: SyncedWorkflow) {
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

interface TriggerView {
  type: WorkflowDefinition["trigger"]["type"];
  summary: string;
  cadence: string;
}

function describeTrigger(trigger: SyncedWorkflow["trigger"]): TriggerView {
  if (trigger.kind === "cron") {
    const cadence = describeCron(trigger.schedule, trigger.timezone);

    return {
      type: "Schedule",
      summary: `Run ${lowerFirst(cadence)}.`,
      cadence,
    };
  }

  if (trigger.kind === "event") {
    const phrase = eventTriggerPhrase(trigger);

    return {
      type: "Event",
      summary: `Run when a ${phrase} event arrives.`,
      cadence: `On ${phrase}`,
    };
  }

  if (trigger.kind === "on_signal") {
    return {
      type: "Event",
      summary: `Run on the '${trigger.name}' signal.`,
      cadence: "On signal",
    };
  }

  return {
    type: "Event",
    summary: "Run manually via Run now.",
    cadence: "Manual",
  };
}

export function syncedWorkflowToView(w: SyncedWorkflow): WorkflowDefinition {
  const { icon, tint, hero } = presentationFor(w);
  const t = describeTrigger(w.trigger);

  return {
    id: w.slug,
    name: w.name,
    description: w.description ?? "",
    cadence: t.cadence,
    icon,
    tint,
    hero,
    status: w.status === "active" ? "active" : "draft",
    prompt: w.brief ?? "",
    trigger: { type: t.type, summary: t.summary },
    integrations:
      w.allowedIntegrations.length > 0 ? w.allowedIntegrations.map(integrationDisplayName) : ["—"],
  };
}
