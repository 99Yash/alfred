import { SYNC_MODEL, type SyncedWorkflow, type WorkflowUpdateArgs } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

export interface WorkflowsState {
  /** Built-in and user-authored, sorted by name. */
  workflows: SyncedWorkflow[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

const scanWorkflows = (tx: ReadTransaction) => SYNC_MODEL.workflow.scan(tx);

const sortByName = (workflows: SyncedWorkflow[]) =>
  workflows.toSorted((a, b) => a.name.localeCompare(b.name));

export function useWorkflows(): WorkflowsState {
  const { data, loading, error, retry } = useReplicacheSubscription(scanWorkflows, sortByName);

  return { workflows: data ?? [], loading, error, retry };
}

export interface WorkflowState {
  workflow: SyncedWorkflow | null;
  /** No-op until the row has synced, because it needs `rowVersion`. */
  updateWorkflow: (args: Omit<WorkflowUpdateArgs, "slug" | "expectedRowVersion">) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useWorkflow(slug: string): WorkflowState {
  const rep = useReplicache();

  const query = useCallback((tx: ReadTransaction) => SYNC_MODEL.workflow.get(tx, { slug }), [slug]);

  const { data, loading, error, retry } = useReplicacheSubscription(query);
  const workflow = data ?? null;

  const updateWorkflow = useCallback(
    async (args: Omit<WorkflowUpdateArgs, "slug" | "expectedRowVersion">): Promise<void> => {
      if (!rep) return;
      const expectedRowVersion = workflow?.rowVersion;

      if (expectedRowVersion === undefined) return;
      await rep.mutate.workflowUpdate({ slug, expectedRowVersion, ...args });
    },
    [workflow?.rowVersion, rep, slug],
  );

  return { workflow, updateWorkflow, loading, error, retry };
}
