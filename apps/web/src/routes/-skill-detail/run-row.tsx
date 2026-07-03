import { AppCard } from "~/components/ui/v2";
import type { SkillFixtureRun } from "~/lib/skills";
import { RunStatusPill } from "./run-status-pill";

export function RunRow({ run }: { run: SkillFixtureRun }) {
  return (
    <AppCard className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-app-fg-4 capitalize">{run.kind}</span>
        <RunStatusPill status={run.status} />
      </div>
      <p className="mt-1 text-[11.5px] text-app-fg-3 tabular-nums">
        Started {new Date(run.startedAt).toLocaleString()}
        {run.endedAt ? ` · ended ${new Date(run.endedAt).toLocaleString()}` : ""}
      </p>
      {run.revisionId ? (
        <p className="mt-0.5 font-mono text-[11px] text-app-fg-2">revision {run.revisionId}</p>
      ) : null}
    </AppCard>
  );
}
