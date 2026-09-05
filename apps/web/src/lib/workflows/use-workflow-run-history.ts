import { workflowRunHistorySchema, type WorkflowRunHistory } from "@alfred/contracts";
import type { SyncedWorkflow } from "@alfred/sync";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { responseErrorMessage } from "~/lib/api-error";
import { client, parseEdenBody } from "~/lib/eden";

/** The first page has no cursor. */
const INITIAL_PAGE_PARAM: string | null = null;
const PAGE_SIZE = 20;

export const workflowRunHistoryKey = (workflowId: string) => ["workflow-runs", workflowId] as const;

/**
 * Keyset pages of one workflow's runs, newest first (#561). The contract parse
 * in `parseEdenBody` is the boundary that proves the server shape.
 *
 * The history is a react-query read, not a synced entity, so a Replicache poke
 * alone does not refresh it. Every terminal commit rolls `lastRunAt` up onto
 * the synced `workflows` row in the same transaction and pokes; this hook
 * watches that synced field and re-fetches when it moves, so a run that just
 * finished leaves "Queued" without a window refocus.
 */
export function useWorkflowRunHistory(
  workflow: Pick<SyncedWorkflow, "id" | "lastRunAt" | "lastRunStatus">,
) {
  const workflowId = workflow.id;
  const queryClient = useQueryClient();
  const lastRunSignal = `${workflow.lastRunAt ?? ""}|${workflow.lastRunStatus ?? ""}`;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: workflowRunHistoryKey(workflowId) });
  }, [queryClient, workflowId, lastRunSignal]);

  return useInfiniteQuery({
    queryKey: workflowRunHistoryKey(workflowId),
    queryFn: async ({ pageParam }: { pageParam: string | null }): Promise<WorkflowRunHistory> => {
      const res = await client.api.workflows({ id: workflowId }).runs.get({
        query: { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
      });
      if (res.error) {
        throw new Error(responseErrorMessage(res.error.value, res.error.status, "Run history"));
      }
      return parseEdenBody(workflowRunHistorySchema, res.data);
    },
    initialPageParam: INITIAL_PAGE_PARAM,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Start a fresh run of the same workflow from a terminal run's revision choice. */
export function useReplayRun(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { runId: string; revisionChoice: "original" | "latest" }) => {
      const res = await client.api.agent.runs({ runId: args.runId }).replay.post({
        requestId: crypto.randomUUID(),
        revisionChoice: args.revisionChoice,
      });
      if (res.error) {
        throw new Error(responseErrorMessage(res.error.value, res.error.status, "Run again"));
      }
      return res.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workflowRunHistoryKey(workflowId) }),
  });
}

/** Start one manual run now. Reads are live; every external write still stages for approval. */
export function useRunWorkflowNow(workflowId: string, workflowSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await client.api.agent.runs.post({
        workflowSlug,
        requestId: crypto.randomUUID(),
      });
      if (res.error) {
        throw new Error(responseErrorMessage(res.error.value, res.error.status, "Run now"));
      }
      return res.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workflowRunHistoryKey(workflowId) }),
  });
}
