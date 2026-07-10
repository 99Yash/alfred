import type { SyncedSkill, SyncedSkillRevision, SyncedSkillRun } from "@alfred/sync";
import { Command, RotateCw } from "lucide-react";
import { useState } from "react";
import { AppTextarea } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { formatRelative } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { EmptyMemoryCard } from "./empty-memory-card";
import { Kbd } from "./kbd";
import { MemoryCard } from "./memory-card";

export function LearnTab({
  skill,
  revision,
  runs,
}: {
  skill: SyncedSkill;
  revision: SyncedSkillRevision | null;
  runs: SyncedSkillRun[];
}) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const hasActiveRun = runs.some(
    (run) => run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled",
  );
  const learning = submitting || hasActiveRun;

  const onRelearn = async () => {
    if (learning || !prompt.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await client.api.skills({ id: skill.id }).relearn.post({
        prompt: prompt.trim(),
      });
      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Re-learn skill"),
        );
      }
      setPrompt("");
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : "Failed to re-learn skill");
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void onRelearn();
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="space-y-2">
          <div>
            <h2 className="text-[15px] font-medium text-app-fg-4">New instructions</h2>
            <p className="mt-1 text-xs text-app-fg-3">
              Add what Alfred should learn next. Previous prompts are not retained.
            </p>
          </div>
          <AppTextarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Add preferences, constraints, or corrections…"
            maxLength={8_000}
            disabled={learning}
            rows={6}
            className="min-h-[140px] font-mono text-[12.5px]"
          />
          <div className="flex items-center justify-end gap-2 text-[11.5px] text-app-fg-3">
            <RotateCw size={11} className="text-app-fg-2" />
            <button
              type="button"
              onClick={() => void onRelearn()}
              disabled={learning || !prompt.trim()}
              className={cn(
                "transition-colors",
                "hover:text-app-fg-4",
                "disabled:cursor-not-allowed disabled:text-app-fg-2",
              )}
            >
              {revision ? "Re-learn" : "Learn"}
            </button>
            <Kbd>
              <Command size={10} />
              <span>↵</span>
            </Kbd>
          </div>
        </div>
        {submitError ? <p className="text-xs text-app-red-4">{submitError}</p> : null}
      </section>

      {learning ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs",
            "bg-app-amber-1 shadow-[0_0_0_1px_var(--app-amber-2)]",
            "text-app-amber-4",
          )}
        >
          <span className="size-2 animate-pulse rounded-full bg-app-amber-4" aria-hidden />
          <span className="font-medium">Learning…</span>
          <span className="opacity-80">distilling the new instructions into memory.</span>
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-baseline gap-2 px-1">
          <h2 className="text-[15px] font-medium text-app-fg-4">Memory update</h2>
          {revision ? (
            <span className="text-[11px] text-app-fg-2 tabular-nums">
              Updated {formatRelative(revision.createdAt)}
            </span>
          ) : null}
        </div>
        {revision ? <MemoryCard body={revision.body} /> : <EmptyMemoryCard />}
      </section>
    </div>
  );
}
