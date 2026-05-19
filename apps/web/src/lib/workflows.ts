import { CalendarClock, CheckCircle2, Mail, type LucideIcon } from "lucide-react";

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
