import { Plus, Sparkles } from "lucide-react";
import { VsButton, VsCard } from "~/components/ui/visitors";
import { BUILTIN_WORKFLOWS } from "~/lib/workflows";
import { WorkflowCard } from "./workflow-card";

const CREATE_LEADING = <Plus size={14} />;

export function PreviewWorkflowsPage() {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-3 max-w-2xl mx-auto vs-card-in">
          <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-vs-fg-4">
            Workflows
          </h1>
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
          <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">
            Built-ins
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {BUILTIN_WORKFLOWS.map((workflow, i) => (
              <WorkflowCard key={workflow.id} workflow={workflow} index={i} />
            ))}
          </div>
        </section>

        <section className="mt-12 space-y-3">
          <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">
            Your workflows
          </h2>
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
      </main>
    </div>
  );
}
