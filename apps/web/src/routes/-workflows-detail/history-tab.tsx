import type { SyncedWorkflow } from "@alfred/sync";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import { AppButton, AppCard } from "~/components/ui/v2";
import {
  useReplayRun,
  useRunWorkflowNow,
  useWorkflowRunHistory,
} from "~/lib/workflows/use-workflow-run-history";
import { HistoryRunRow } from "./history-run-row";

const PLAY_LEADING = <Play size={14} />;

/**
 * Real run history (#561): keyset pages from `GET /api/workflows/:id/runs`,
 * each row with its frozen outcome, the live write ledger, and one recovery.
 * The top card starts a manual run when the workflow is active and
 * user-authored; built-ins are driven by their own schedules.
 */
export function HistoryTab({ workflow }: { workflow: SyncedWorkflow }) {
  const navigate = useNavigate({ from: "/workflows/$workflow" });
  const history = useWorkflowRunHistory(workflow);
  const replay = useReplayRun(workflow.id);
  const runNow = useRunWorkflowNow(workflow.id, workflow.slug);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const canRunNow = !workflow.isBuiltin && workflow.status === "active";
  const rows = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="grid gap-4">
      {canRunNow ? (
        <AppCard className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-app-fg-4">Run a test now</p>
            <p className="mt-1 text-xs leading-5 text-pretty text-app-fg-3">
              This starts a real manual run. Alfred can read your connected data. Every external
              write still waits for your approval.
            </p>
            {runNow.isError ? (
              <p className="mt-1 text-xs text-rose-600">{runNow.error.message}</p>
            ) : null}
          </div>
          <AppButton
            variant="primary"
            size="md"
            leading={PLAY_LEADING}
            disabled={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            {runNow.isPending ? "Starting…" : "Run now"}
          </AppButton>
        </AppCard>
      ) : null}

      <AppCard>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-app-fg-4">Runs</p>
          {history.isFetching && !history.isFetchingNextPage ? (
            <LoaderCircle size={14} className="animate-spin text-app-fg-2" aria-hidden />
          ) : null}
        </div>
        {replay.isError ? (
          <p className="mb-2 text-xs text-rose-600">{replay.error.message}</p>
        ) : null}

        {history.isPending ? (
          <p className="py-6 text-center text-xs text-app-fg-3">Loading runs…</p>
        ) : history.isError ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-xs text-rose-600">{history.error.message}</p>
            <AppButton variant="white" size="sm" onClick={() => void history.refetch()}>
              Try again
            </AppButton>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-app-fg-3">No runs yet.</p>
        ) : (
          <div className="divide-y divide-app-bg-3">
            {rows.map((row) => (
              <HistoryRunRow
                key={row.id}
                row={row}
                expanded={expandedRunId === row.id}
                onToggleExpanded={() =>
                  setExpandedRunId((current) => (current === row.id ? null : row.id))
                }
                onRecheck={(revisionId) =>
                  void navigate({
                    search: { workflow_recovery: "1", revision_id: revisionId },
                  })
                }
                onRunAgain={(runId, revisionChoice) => replay.mutate({ runId, revisionChoice })}
                runAgainPending={replay.isPending && replay.variables?.runId === row.id}
              />
            ))}
          </div>
        )}

        {history.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <AppButton
              variant="ghost"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? "Loading…" : "Load more"}
            </AppButton>
          </div>
        ) : null}
      </AppCard>
    </div>
  );
}
