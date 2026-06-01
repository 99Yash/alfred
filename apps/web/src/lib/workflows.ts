import type { SyncedWorkflow } from "@alfred/sync";
import {
  CalendarClock,
  CheckCircle2,
  type LucideIcon,
  Mail,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";

export type WorkflowTint = "violet" | "emerald" | "amber";

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  cadence: string;
  icon: LucideIcon;
  tint: WorkflowTint;
  status: "active" | "draft";
  prompt: string;
  trigger: {
    type: "Schedule" | "Event";
    summary: string;
  };
  integrations: ReadonlyArray<string>;
};

export const BUILTIN_WORKFLOWS: ReadonlyArray<WorkflowDefinition> = [
  {
    id: "morning-briefing",
    name: "Morning briefing",
    description: "Inbox-only digest delivered every morning via email.",
    cadence: "Every day at 08:00",
    icon: Mail,
    tint: "violet",
    status: "active",
    trigger: {
      type: "Schedule",
      summary: "Run every day at 08:00 and send a concise inbox briefing.",
    },
    integrations: ["Gmail"],
    prompt:
      "Summarize the overnight inbox, identify messages that need same-day attention, and send a short morning briefing.",
  },
  {
    id: "email-triage",
    name: "Email triage",
    description: "Classifies new Gmail messages and writes labels back.",
    cadence: "After Gmail polling",
    icon: CheckCircle2,
    tint: "emerald",
    status: "active",
    trigger: {
      type: "Event",
      summary: "Run after new Gmail messages are synced.",
    },
    integrations: ["Gmail"],
    prompt:
      "Classify new inbox messages, decide whether they need action, and write the appropriate triage labels back to Gmail.",
  },
  {
    id: "cold-start-research",
    name: "Cold-start research",
    description: "Builds initial facts from integration signals at signup.",
    cadence: "Once after Google connect",
    icon: CalendarClock,
    tint: "amber",
    status: "active",
    trigger: {
      type: "Event",
      summary: "Run once after Google account connection completes.",
    },
    integrations: ["Google Workspace", "Research"],
    prompt:
      "Gather initial user and workspace context, research likely company facts, extract durable memory candidates, and persist non-duplicative facts.",
  },
];

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return BUILTIN_WORKFLOWS.find((workflow) => workflow.id === id);
}

/**
 * Presentation (icon + tint) for the three flagship built-ins keeps their
 * bespoke hero art (keyed by slug in `WorkflowCard`); everything else gets
 * a deterministic fallback so user-authored workflows still look intentional.
 */
const KNOWN_PRESENTATION: Readonly<Record<string, { icon: LucideIcon; tint: WorkflowTint }>> = {
  "morning-briefing": { icon: Mail, tint: "violet" },
  "daily-briefing": { icon: Mail, tint: "violet" },
  "email-triage": { icon: CheckCircle2, tint: "emerald" },
  "cold-start-research": { icon: CalendarClock, tint: "amber" },
};

const FALLBACK_TINTS: ReadonlyArray<WorkflowTint> = ["violet", "emerald", "amber"];

function hashSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

function presentationFor(w: SyncedWorkflow): {
  icon: LucideIcon;
  tint: WorkflowTint;
} {
  const known = KNOWN_PRESENTATION[w.slug];
  if (known) return known;
  const tint = FALLBACK_TINTS[hashSlug(w.slug) % FALLBACK_TINTS.length] ?? "violet";
  const icon =
    w.trigger.kind === "cron" ? CalendarClock : w.trigger.kind === "event" ? Zap : WorkflowIcon;
  return { icon, tint };
}

function titleCase(slug: string): string {
  return slug
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/** "0 7 * * *" → "Every day at 07:00"; falls back to the raw expression. */
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
    const source = titleCase(trigger.source);
    const event = titleCase(trigger.type.replace(/_received$/, ""));
    return {
      type: "Event",
      summary: `Run when a ${source} ${event.toLowerCase()} arrives.`,
      cadence: `On ${source} ${event.toLowerCase()}`,
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

/**
 * Project a synced workflow row onto the cosmetic `WorkflowDefinition` view
 * model the list cards, heroes, history/share tabs already consume. The
 * editable PlanTab works off the raw `SyncedWorkflow` instead — this view is
 * display-only.
 */
export function syncedWorkflowToView(w: SyncedWorkflow): WorkflowDefinition {
  const { icon, tint } = presentationFor(w);
  const t = describeTrigger(w.trigger);
  return {
    id: w.slug,
    name: w.name,
    description: w.description ?? "",
    cadence: t.cadence,
    icon,
    tint,
    status: w.status === "active" ? "active" : "draft",
    prompt: w.brief ?? "",
    trigger: { type: t.type, summary: t.summary },
    integrations: w.allowedIntegrations.length > 0 ? w.allowedIntegrations.map(titleCase) : ["—"],
  };
}
