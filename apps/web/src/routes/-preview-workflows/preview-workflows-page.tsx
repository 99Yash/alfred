import { Plus, Sparkles } from "lucide-react";
import { VsButton, VsCard } from "~/components/ui/visitors";
import { useWorkflows } from "~/lib/replicache/use-workflows";
import { syncedWorkflowToView } from "~/lib/workflows";
import { WorkflowCard } from "./workflow-card";

const CREATE_LEADING = <Plus size={14} />;

export function PreviewWorkflowsPage() {
  const { workflows, loading } = useWorkflows();
  const builtins = workflows.filter((w) => w.isBuiltin);
  const authored = workflows.filter((w) => !w.isBuiltin);

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
              title="Author a workflow from chat; full create flow lands next"
            >
              Create workflow
            </VsButton>
          </div>
        </header>

        <section className="mt-12 space-y-3">
          <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">
            Built-ins
          </h2>
          {builtins.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {builtins.map((w, i) => (
                <WorkflowCard key={w.slug} workflow={syncedWorkflowToView(w)} index={i} />
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-vs-fg-3">
              {loading ? "Loading workflows…" : "No built-in workflows seeded yet."}
            </p>
          )}
        </section>

        <section className="mt-12 space-y-3">
          <h2 className="text-xs uppercase tracking-tight text-vs-fg-2 font-medium px-1">
            Your workflows
          </h2>
          {authored.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {authored.map((w, i) => (
                <WorkflowCard key={w.slug} workflow={syncedWorkflowToView(w)} index={i} />
              ))}
            </div>
          ) : (
            <VsCard
              padded={false}
              className="vs-card-in flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
              style={{ animationDelay: `${builtins.length * 70 + 80}ms` }}
            >
              <span
                className="inline-flex size-9 items-center justify-center rounded-full border border-vs-bg-3 text-vs-fg-3"
                aria-hidden
              >
                <Sparkles size={16} />
              </span>
              <p className="text-sm font-medium text-vs-fg-4">No workflows yet</p>
              <p className="max-w-[28rem] text-xs text-vs-fg-3 leading-5">
                Author your own scheduled or event-driven flows from chat, then tune their trigger
                and integrations here.
              </p>
            </VsCard>
          )}
        </section>
      </main>
    </div>
  );
}
