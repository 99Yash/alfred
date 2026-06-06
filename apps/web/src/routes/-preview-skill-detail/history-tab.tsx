import { Clock } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import type { PreviewSkill } from "~/lib/preview-skills";
import { RunRow } from "./run-row";

export function HistoryTab({ skill }: { skill: PreviewSkill }) {
  if (skill.runs.length === 0) {
    return (
      <AppCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <span
          className="grid size-10 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3"
          aria-hidden
        >
          <Clock size={18} />
        </span>
        <p className="text-sm font-medium text-app-fg-4">No runs yet</p>
        <p className="text-xs text-app-fg-3">
          A run starts every time you Learn or Re-learn this skill.
        </p>
      </AppCard>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-[15px] font-medium text-app-fg-4">Runs</h2>
        <span className="text-xs text-app-fg-2 tabular-nums">{skill.runs.length}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {skill.runs.map((run) => (
          <li key={run.id}>
            <RunRow run={run} />
          </li>
        ))}
      </ul>
    </section>
  );
}
