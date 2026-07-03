import { Command, RotateCw } from "lucide-react";
import { useState } from "react";
import { AppTextarea } from "~/components/ui/v2";
import type { SkillFixture } from "~/lib/skills";
import { formatRelative } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { EmptyMemoryCard } from "./empty-memory-card";
import { Kbd } from "./kbd";
import { MemoryCard } from "./memory-card";

export function LearnTab({ skill, initialPrompt }: { skill: SkillFixture; initialPrompt: string }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [learning, setLearning] = useState(false);

  const onRelearn = () => {
    if (learning || !prompt.trim()) return;
    setLearning(true);
    setTimeout(() => setLearning(false), 1500);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRelearn();
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-app-fg-4">Using Integrations</h3>
          <p className="text-xs text-app-fg-3">
            {skill.integrations.length > 0
              ? `${skill.integrations.join(", ")}. You can mention integrations using @ in the prompt.`
              : "You can mention integrations using @ in the prompt."}
          </p>
        </div>
        <div className="space-y-2">
          <h2 className="text-[15px] font-medium text-app-fg-4">Prompt</h2>
          <AppTextarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Preferences, constraints, hard rules…"
            maxLength={8_000}
            disabled={learning}
            rows={6}
            className="min-h-[140px] font-mono text-[12.5px]"
          />
          <div className="flex items-center justify-end gap-2 text-[11.5px] text-app-fg-3">
            <RotateCw size={11} className="text-app-fg-2" />
            <button
              type="button"
              onClick={onRelearn}
              disabled={learning || !prompt.trim()}
              className={cn(
                "transition-colors",
                "hover:text-app-fg-4",
                "disabled:cursor-not-allowed disabled:text-app-fg-2",
              )}
            >
              {skill.memoryBody ? "Re-learn" : "Learn"}
            </button>
            <Kbd>
              <Command size={10} />
              <span>↵</span>
            </Kbd>
          </div>
        </div>
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
          <span className="opacity-80">distilling the prompt into memory.</span>
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-baseline gap-2 px-1">
          <h2 className="text-[15px] font-medium text-app-fg-4">Memory update</h2>
          {skill.memoryBody ? (
            <span className="text-[11px] text-app-fg-2 tabular-nums">
              Updated {formatRelative(skill.updatedAt)}
            </span>
          ) : null}
        </div>
        {skill.memoryBody ? <MemoryCard body={skill.memoryBody} /> : <EmptyMemoryCard />}
      </section>
    </div>
  );
}
