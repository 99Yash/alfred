import { Link } from "@tanstack/react-router";
import { Clock3, type LucideIcon } from "lucide-react";
import type { WorkflowDefinition } from "~/lib/workflows";
import { cn } from "~/lib/utils";
import { BriefingHero } from "./briefing-hero";
import { TriageHero } from "./triage-hero";
import { ResearchHero } from "./research-hero";

const TINT: Record<
  WorkflowDefinition["tint"],
  { bg: string; chip: string; ring: string; accent: string }
> = {
  violet: {
    bg: "bg-app-purple-1",
    chip: "bg-app-purple-2 text-app-purple-4",
    ring: "ring-app-purple-2",
    accent: "text-app-purple-4",
  },
  emerald: {
    bg: "bg-app-green-1",
    chip: "bg-app-green-2 text-app-green-4",
    ring: "ring-app-green-2",
    accent: "text-app-green-4",
  },
  amber: {
    bg: "bg-app-amber-1",
    chip: "bg-app-amber-2 text-app-amber-4",
    ring: "ring-app-amber-2",
    accent: "text-app-amber-4",
  },
};

export function WorkflowCard({ workflow, index }: { workflow: WorkflowDefinition; index: number }) {
  const Icon: LucideIcon = workflow.icon;
  const tint = TINT[workflow.tint];
  return (
    <Link
      to="/workflows/$workflow"
      params={{ workflow: workflow.id }}
      className={cn(
        "app-card-in app-hover-lift app-press",
        "group flex min-h-[268px] flex-col overflow-hidden rounded-2xl bg-app-bg-1",
        "shadow-[var(--app-shadow-elevated)] hover:shadow-[var(--app-shadow-elevated-hover)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
      )}
      style={{ animationDelay: `${index * 70 + 60}ms` }}
    >
      {/* Hero preview — unique per workflow. Lives in a tinted panel
       *  at the top; the icon overlaps the bottom edge for a small
       *  scrapbook feel. */}
      <div
        className={cn(
          "relative h-[120px] overflow-hidden",
          tint.bg,
          "[mask:linear-gradient(to_bottom,black_70%,transparent_100%)]",
        )}
      >
        {workflow.id === "morning-briefing" && <BriefingHero accent={tint.accent} />}
        {workflow.id === "email-triage" && <TriageHero accent={tint.accent} />}
        {workflow.id === "cold-start-research" && <ResearchHero accent={tint.accent} />}
      </div>

      <div className="relative -mt-5 flex flex-1 flex-col p-5">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-1 ring-1",
            "shadow-[var(--app-shadow-elevated)]",
            tint.ring,
            tint.accent,
          )}
          aria-hidden
        >
          <Icon size={16} />
        </span>
        <div className="mt-3 min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-app-fg-4">{workflow.name}</p>
          <p className="mt-1 line-clamp-3 text-xs leading-5 text-app-fg-3">
            {workflow.description}
          </p>
        </div>
        <span className="mt-3 inline-flex w-fit items-center gap-1 rounded-md bg-app-bg-2 px-2 py-0.5 text-[11px] text-app-fg-3 tabular-nums">
          <Clock3 size={11} />
          {workflow.cadence}
        </span>
      </div>
    </Link>
  );
}
