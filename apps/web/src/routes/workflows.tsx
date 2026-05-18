import { createFileRoute } from "@tanstack/react-router";
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Mail,
  Plus,
  Sparkles,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/workflows")({
  component: WorkflowsPage,
});

type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

interface Workflow {
  name: string;
  description: string;
  cadence: string;
  icon: LucideIcon;
  /** Tile tint — matches the Dimension brand-tile pattern. */
  tint: "violet" | "emerald" | "amber";
}

const BUILTINS: ReadonlyArray<Workflow> = [
  {
    name: "Morning briefing",
    description: "Inbox-only digest delivered every morning via email.",
    cadence: "Every day at 08:00",
    icon: Mail,
    tint: "violet",
  },
  {
    name: "Email triage",
    description: "Classifies new Gmail messages and writes labels back.",
    cadence: "After Gmail polling",
    icon: CheckCircle2,
    tint: "emerald",
  },
  {
    name: "Cold-start research",
    description: "Builds initial facts from integration signals at signup.",
    cadence: "Once after Google connect",
    icon: CalendarClock,
    tint: "amber",
  },
];

function WorkflowsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      {/* Spacer so the mobile hamburger doesn't collide with the page title. */}
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Workflows
        </h1>
        <p className="text-sm text-gray-800">
          Create scheduled or trigger-based work Alfred runs on its own.
        </p>
        <div className="pt-2 flex justify-center">
          <Button
            variant="primary"
            size="lg"
            leading={<Plus size={14} />}
            disabled
            title="User-authored workflows arrive in m12"
          >
            Create Workflow
          </Button>
        </div>
      </header>

      <div className="mt-12 space-y-12">
        <section className="space-y-3">
          <h2 className="text-[15px] font-medium text-gray-1000">Built-ins</h2>
          <div className="flex flex-col gap-1">
            {BUILTINS.map((workflow) => (
              <WorkflowCard key={workflow.name} workflow={workflow} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[15px] font-medium text-gray-1000">
            Your workflows
          </h2>
          <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span
              className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
              aria-hidden
            >
              <Sparkles size={18} />
            </span>
            <p className="text-sm font-medium text-gray-950">
              No workflows yet
            </p>
            <p className="max-w-[28rem] text-[12.5px] text-gray-800">
              Author your own scheduled or event-driven flows once user-authored
              workflows land in milestone 12.
            </p>
          </Card>
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Workflow card                                                              */
/* -------------------------------------------------------------------------- */

const TINT: Record<Workflow["tint"], string> = {
  violet:
    "bg-[rgb(var(--purple-400)/0.16)] text-[rgb(var(--purple-700))] " +
    "ring-1 ring-inset ring-[rgb(var(--purple-400)/0.18)]",
  emerald:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/20",
  amber:
    "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/20",
};

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const Icon = workflow.icon;
  return (
    <Card
      interactive
      className={cn(
        "flex items-center gap-3 px-3 py-2.5 text-gray-950",
        /* Cursor opt-out — Card.interactive sets cursor-pointer, but the
         * built-ins aren't clickable yet. Override until editor lands. */
        "cursor-default hover:bg-[#181818]",
      )}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-xl",
          TINT[workflow.tint],
        )}
        aria-hidden
      >
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-950">
          {workflow.name}
        </p>
        <p className="truncate text-[12.5px] text-gray-800">
          {workflow.description}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-gray-800 tabular">
        <Clock3 size={11} />
        {workflow.cadence}
      </span>
    </Card>
  );
}
