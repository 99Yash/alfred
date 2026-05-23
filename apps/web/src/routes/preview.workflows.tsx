import { createFileRoute, Link } from "@tanstack/react-router";
import { Clock3, Plus, Sparkles, type LucideIcon } from "lucide-react";
import { VsButton, VsCard } from "~/components/ui/visitors";
import { BUILTIN_WORKFLOWS, type WorkflowDefinition } from "~/lib/workflows";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /workflows.
 *
 * Same data + same IA as the original (centered hero, built-ins grid,
 * empty "Your workflows" state), but rebuilt on VsCard + VsButton + the
 * .vs subtree scope so we can A/B against /workflows directly. The
 * original route is untouched.
 *
 * Compare:
 *   /workflows            → dimension grammar (dark, gradient title, frost icon tile)
 *   /preview/workflows    → visitors-now grammar (white, ink title, hue-tinted dot)
 */
export const Route = createFileRoute("/preview/workflows")({
  component: PreviewWorkflowsPage,
});

function PreviewWorkflowsPage() {
  return (
    <div className="vs min-h-dvh">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-3 max-w-2xl mx-auto">
          <h1 className="text-[36px] leading-[44px] font-medium text-vs-fg-4">Workflows</h1>
          <p className="text-sm text-vs-fg-3">
            Create scheduled or trigger-based work Alfred runs on its own.
          </p>
          <div className="pt-3 flex justify-center">
            <VsButton
              variant="primary"
              size="lg"
              leading={<Plus size={14} />}
              disabled
              title="User-authored workflows arrive in m12"
            >
              Create workflow
            </VsButton>
          </div>
        </header>

        <section className="mt-12 space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-vs-fg-2 font-medium px-1">Built-ins</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {BUILTIN_WORKFLOWS.map((workflow) => (
              <WorkflowCard key={workflow.id} workflow={workflow} />
            ))}
          </div>
        </section>

        <section className="mt-12 space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-vs-fg-2 font-medium px-1">Your workflows</h2>
          <VsCard padded={false} className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
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

/* The TINT map mirrors the data model's `tint` field but maps each hue to
 * the visitors-now token scale: -1 bg tint, -4 accent foreground. The
 * effect is a softly-colored chip-icon instead of dimension's frosted tile. */
const TINT: Record<WorkflowDefinition["tint"], string> = {
  violet: "bg-vs-purple-1 text-vs-purple-4",
  emerald: "bg-vs-green-1 text-vs-green-4",
  amber: "bg-vs-amber-1 text-vs-amber-4",
};

function WorkflowCard({ workflow }: { workflow: WorkflowDefinition }) {
  const Icon: LucideIcon = workflow.icon;
  return (
    <Link
      to="/workflows/$workflow"
      params={{ workflow: workflow.id }}
      className={cn(
        "group flex min-h-[212px] flex-col p-5 rounded-2xl bg-vs-bg-1 overflow-hidden",
        "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
        "transition-shadow vs-press cursor-pointer",
        "hover:shadow-[0_2px_4px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.08)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
    >
      <span
        className={cn("grid size-10 shrink-0 place-items-center rounded-xl", TINT[workflow.tint])}
        aria-hidden
      >
        <Icon size={18} />
      </span>
      <div className="mt-4 min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium text-vs-fg-4">{workflow.name}</p>
        <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-vs-fg-3">{workflow.description}</p>
      </div>
      <span className="mt-4 inline-flex w-fit items-center gap-1 rounded-full bg-vs-bg-2 px-2.5 py-1 text-[11px] text-vs-fg-3 tabular-nums">
        <Clock3 size={11} />
        {workflow.cadence}
      </span>
    </Link>
  );
}

