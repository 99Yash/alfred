import { Link } from "@tanstack/react-router";
import { Clock3, type LucideIcon } from "lucide-react";
import type { WorkflowDefinition } from "~/lib/workflows";
import { cn } from "~/lib/utils";
import { BriefingHero } from "./briefing-hero";
import { TriageHero } from "./triage-hero";
import { ResearchHero } from "./research-hero";

const TINT: Record<WorkflowDefinition["tint"], { bg: string; chip: string; ring: string; accent: string }> = {
  violet: {
    bg: "bg-vs-purple-1",
    chip: "bg-vs-purple-2 text-vs-purple-4",
    ring: "ring-vs-purple-2",
    accent: "text-vs-purple-4",
  },
  emerald: {
    bg: "bg-vs-green-1",
    chip: "bg-vs-green-2 text-vs-green-4",
    ring: "ring-vs-green-2",
    accent: "text-vs-green-4",
  },
  amber: {
    bg: "bg-vs-amber-1",
    chip: "bg-vs-amber-2 text-vs-amber-4",
    ring: "ring-vs-amber-2",
    accent: "text-vs-amber-4",
  },
};

export function WorkflowCard({ workflow, index }: { workflow: WorkflowDefinition; index: number }) {
  const Icon: LucideIcon = workflow.icon;
  const tint = TINT[workflow.tint];
  return (
    <Link
      to="/preview/workflows/$workflow"
      params={{ workflow: workflow.id }}
      className={cn(
        "vs-card-in vs-hover-lift vs-press",
        "group flex min-h-[268px] flex-col rounded-2xl bg-vs-bg-1 overflow-hidden",
        "shadow-[var(--vs-shadow-elevated)] hover:shadow-[var(--vs-shadow-elevated-hover)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
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

      <div className="flex flex-col flex-1 p-5 -mt-5 relative">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl bg-vs-bg-1 ring-1",
            "shadow-[var(--vs-shadow-elevated)]",
            tint.ring,
            tint.accent,
          )}
          aria-hidden
        >
          <Icon size={16} />
        </span>
        <div className="mt-3 min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium text-vs-fg-4">{workflow.name}</p>
          <p className="mt-1 line-clamp-3 text-xs leading-5 text-vs-fg-3">{workflow.description}</p>
        </div>
        <span className="mt-3 inline-flex w-fit items-center gap-1 rounded-md bg-vs-bg-2 px-2 py-0.5 text-[11px] text-vs-fg-3 tabular-nums">
          <Clock3 size={11} />
          {workflow.cadence}
        </span>
      </div>
    </Link>
  );
}
