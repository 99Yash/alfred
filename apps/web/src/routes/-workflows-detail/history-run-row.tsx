import {
  humanizeSlug,
  humanizeToolName,
  integrationDisplayName,
  type WorkflowRunHistoryRow,
} from "@alfred/contracts";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  Clock,
  LoaderCircle,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { AppButton, AppPill } from "~/components/ui/v2";
import { formatTimestamp } from "~/components/approvals/format";
import { API_URL } from "~/lib/eden";
import {
  effectCounts,
  revisionLabel,
  runHeadline,
  timingLabel,
  triggerIdentity,
  type RunHeadline,
} from "./history-format";
import { WorkflowIcon } from "./workflow-icon";

export interface HistoryRunRowProps {
  row: WorkflowRunHistoryRow;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRecheck: (revisionId: string) => void;
  onRunAgain: (runId: string, revisionChoice: "original" | "latest") => void;
  runAgainPending: boolean;
}

function headlineIcon(headline: RunHeadline, status: WorkflowRunHistoryRow["status"]) {
  if (status === "running" || status === "pending" || status === "runnable") {
    return <LoaderCircle size={16} className="animate-spin" />;
  }
  if (status === "waiting" || status === "deferred") return <Clock size={16} />;
  switch (headline.tone) {
    case "green":
      return <CheckCircle2 size={16} />;
    case "red":
      return <XCircle size={16} />;
    case "amber":
      return <CircleAlert size={16} />;
    case "purple":
      return <LoaderCircle size={16} className="animate-spin" />;
    case "muted":
      return status === "cancelled" ? <Ban size={16} /> : <MinusCircle size={16} />;
  }
}

/** One run in the History tab: what happened, why it fired, and the one thing to do next. */
export function HistoryRunRow({
  row,
  expanded,
  onToggleExpanded,
  onRecheck,
  onRunAgain,
  runAgainPending,
}: HistoryRunRowProps) {
  const headline = runHeadline(row);
  const counts = effectCounts(row.effects);
  const recovery = row.recovery;

  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex items-start gap-3">
        <WorkflowIcon tone={headline.tone}>{headlineIcon(headline, row.status)}</WorkflowIcon>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-app-fg-4">{headline.title}</p>
          {headline.detail ? (
            <p className="mt-0.5 text-xs leading-5 text-pretty text-app-fg-3">{headline.detail}</p>
          ) : null}
          <p className="mt-1 truncate text-[11px] text-app-fg-2">
            {triggerIdentity(row.trigger)} · {revisionLabel(row)}
            {row.replayOfRunId ? " · replay" : ""}
          </p>
          {row.coverageGaps.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-700">
              {row.coverageGaps.map((problem) => (
                <li key={`${problem.code}:${problem.field}`}>{problem.message}</li>
              ))}
            </ul>
          ) : null}
          {counts.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {counts.map((entry) => (
                <AppPill key={entry.key} tone={entry.tone} type="button" tabIndex={-1}>
                  {entry.count} {entry.label}
                </AppPill>
              ))}
              {row.effectsTruncated ? (
                <span className="self-center text-[11px] text-app-fg-2">
                  Showing the first {row.effects.length}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 text-right">
          <p className="text-[11px] text-app-fg-2">{timingLabel(row)}</p>
          {recovery.kind === "oauth" ? (
            <AppButton
              variant="primary"
              size="sm"
              onClick={() => {
                window.location.href = `${API_URL}${recovery.path}`;
              }}
            >
              {recovery.label}
            </AppButton>
          ) : null}
          {recovery.kind === "recheck" ? (
            <AppButton variant="white" size="sm" onClick={() => onRecheck(recovery.revisionId)}>
              Recheck setup
            </AppButton>
          ) : null}
          {recovery.kind === "run_again" ? (
            <AppButton
              variant="white"
              size="sm"
              disabled={runAgainPending}
              onClick={() => onRunAgain(row.id, recovery.revisionChoice)}
            >
              {runAgainPending ? "Starting…" : "Run again"}
            </AppButton>
          ) : null}
          {recovery.kind === "inspect" && row.effects.length > 0 ? (
            <AppButton variant="ghost" size="sm" onClick={onToggleExpanded}>
              {expanded ? "Hide writes" : "Show writes"}
            </AppButton>
          ) : null}
          {recovery.kind === "none" && row.outcome ? (
            <p className="text-[11px] text-app-fg-2">No automatic retry</p>
          ) : null}
        </div>
      </div>

      {expanded && row.effects.length > 0 ? (
        <ul className="ml-12 divide-y divide-app-bg-3 overflow-hidden rounded-2xl bg-app-bg-2/40 shadow-[0_0_0_1px_rgba(0,0,0,0.04)]">
          {row.effects.map((effect) => (
            <li
              key={effect.effectKey}
              className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs"
            >
              <span className="min-w-0 truncate text-app-fg-4">
                {humanizeToolName(effect.toolName)}
                <span className="text-app-fg-2">
                  {" "}
                  · {integrationDisplayName(effect.integration)}
                </span>
              </span>
              <span className="shrink-0 text-app-fg-3">
                {humanizeSlug(effect.outcome)}
                {effect.executedAt ? ` · ${formatTimestamp(effect.executedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
