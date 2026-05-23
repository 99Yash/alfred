import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { Clock3, Plus, Sparkles, type LucideIcon } from "lucide-react";
import { VsButton, VsCard } from "~/components/ui/visitors";
import { BUILTIN_WORKFLOWS, type WorkflowDefinition } from "~/lib/workflows";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /workflows.
 *
 * Same data + same IA as the original (centered hero, built-ins grid,
 * empty "Your workflows" state), but rebuilt on VsCard + VsButton with a
 * per-workflow visual hero — each card shows a stylized preview of what
 * the workflow produces (stacked email rows for briefing, label chips for
 * triage, fact cards for research) instead of a flat icon-tile.
 *
 * Theme: defaults to system preference, override-able via the toggle
 * in the top-right.
 *
 * Compare:
 *   /workflows            → dimension grammar (dark, gradient title, frost tile)
 *   /preview/workflows    → visitors-now grammar (theme-aware, hero previews)
 */
export const Route = createFileRoute("/preview/workflows")({
  component: PreviewWorkflowsRoute,
});

const CREATE_LEADING = <Plus size={14} />;

function PreviewWorkflowsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewWorkflowsPage />;
}

function PreviewWorkflowsPage() {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
          <header className="text-center space-y-3 max-w-2xl mx-auto vs-card-in">
            <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-vs-fg-4">Workflows</h1>
            <p className="text-sm text-vs-fg-3">
              Create scheduled or trigger-based work Alfred runs on its own.
            </p>
            <div className="pt-3 flex justify-center">
              <VsButton
                variant="primary"
                size="lg"
                leading={CREATE_LEADING}
                disabled
                title="User-authored workflows arrive in m12"
              >
                Create workflow
              </VsButton>
            </div>
          </header>

          <section className="mt-12 space-y-3">
            <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">Built-ins</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {BUILTIN_WORKFLOWS.map((workflow, i) => (
                <WorkflowCard key={workflow.id} workflow={workflow} index={i} />
              ))}
            </div>
          </section>

          <section className="mt-12 space-y-3">
            <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">Your workflows</h2>
            <VsCard
              padded={false}
              className="vs-card-in flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
              style={{ animationDelay: `${BUILTIN_WORKFLOWS.length * 70 + 80}ms` }}
            >
              <span
                className="inline-flex size-9 items-center justify-center rounded-full border border-vs-bg-3 text-vs-fg-3"
                aria-hidden
              >
                <Sparkles size={16} />
              </span>
              <p className="text-sm font-medium text-vs-fg-4">No workflows yet</p>
              <p className="max-w-[28rem] text-xs text-vs-fg-3 leading-5">
                Author your own scheduled or event-driven flows once user-authored workflows land in
                milestone 12.
              </p>
            </VsCard>
          </section>

          <footer className="mt-16 flex items-center justify-center text-xs text-vs-fg-2 gap-2">
            <span>Comparing against</span>
            <Link to="/workflows" className="font-medium text-vs-fg-3 hover:text-vs-fg-4">
              /workflows
            </Link>
          </footer>
        </main>
    </div>
  );
}

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

function WorkflowCard({ workflow, index }: { workflow: WorkflowDefinition; index: number }) {
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

/* ----------------------------------------------------------------------- */
/* Hero previews — each is a small stylized HTML composition that hints   */
/* at what the workflow produces.                                          */
/* ----------------------------------------------------------------------- */

function BriefingHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {/* Three stacked email rows, slightly fanned. Hover fans them more. */}
      <div className="relative w-[78%]">
        <EmailRow className="vs-stack vs-stack-back -translate-x-2 -translate-y-1 opacity-60" />
        <EmailRow className="vs-stack vs-stack-mid translate-y-2" />
        <EmailRow
          className="vs-stack vs-stack-front translate-x-3 translate-y-5"
          highlight
          accent={accent}
        />
      </div>
    </div>
  );
}

function EmailRow({
  className,
  highlight,
  accent,
}: {
  className?: string;
  highlight?: boolean;
  accent?: string;
}) {
  return (
    <div
      className={cn(
        "h-[34px] rounded-lg bg-vs-bg-2 px-2.5 flex items-center gap-2",
        "shadow-[var(--vs-shadow-elevated)] absolute inset-x-0",
        highlight && cn("bg-vs-bg-1", accent),
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", highlight ? accent : "bg-vs-fg-2")} aria-hidden style={highlight ? { backgroundColor: "currentColor" } : undefined} />
      <span className="flex-1">
        <span className={cn("block h-1.5 w-[60%] rounded-full", highlight ? "bg-vs-fg-3" : "bg-vs-fg-2/40")} />
        <span className="block h-1 w-[40%] rounded-full bg-vs-fg-2/25 mt-1" />
      </span>
    </div>
  );
}

function TriageHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative flex items-center gap-2">
        {[
          { label: "Inbox", tone: "bg-vs-bg-2 text-vs-fg-3" },
          { label: "Action", tone: cn("bg-vs-bg-1", accent), classNames: "vs-stack vs-stack-mid" },
          { label: "Newsletter", tone: "bg-vs-bg-2 text-vs-fg-3", classNames: "vs-stack vs-stack-back" },
          { label: "Receipt", tone: "bg-vs-bg-2 text-vs-fg-3", classNames: "vs-stack vs-stack-front" },
        ].map((chip, i) => (
          <span
            key={chip.label}
            className={cn(
              "inline-flex items-center h-7 px-2.5 rounded-lg text-[11px] font-medium",
              "shadow-[var(--vs-shadow-elevated)]",
              chip.tone,
              chip.classNames,
            )}
            style={{ transitionDelay: `${i * 30}ms` }}
          >
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ResearchHero({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative w-[78%] h-[80px]">
        <FactCard className="vs-stack vs-stack-back top-0 -translate-x-2 rotate-[-3deg] opacity-60" />
        <FactCard className="vs-stack vs-stack-mid top-3 left-2 rotate-[0deg]" />
        <FactCard
          className="vs-stack vs-stack-front top-6 left-6 rotate-[3deg]"
          highlight
          accent={accent}
        />
      </div>
    </div>
  );
}

function FactCard({
  className,
  highlight,
  accent,
}: {
  className?: string;
  highlight?: boolean;
  accent?: string;
}) {
  return (
    <div
      className={cn(
        "absolute w-[60%] h-[52px] rounded-lg px-3 py-2",
        "shadow-[var(--vs-shadow-elevated)] flex flex-col gap-1.5 justify-center",
        highlight ? cn("bg-vs-bg-1", accent) : "bg-vs-bg-2",
        className,
      )}
    >
      <span className={cn("block h-1.5 w-[70%] rounded-full", highlight ? accent : "bg-vs-fg-2/40")} style={highlight ? { backgroundColor: "currentColor" } : undefined} />
      <span className="block h-1 w-[40%] rounded-full bg-vs-fg-2/25" />
    </div>
  );
}
