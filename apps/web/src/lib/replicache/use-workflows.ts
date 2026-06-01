import {
  IDB_KEY,
  type SyncedWorkflow,
  syncedWorkflowSchema,
  type WorkflowUpdateArgs,
} from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

export interface WorkflowsState {
  /** All synced workflows (built-in + user-authored), name-sorted. */
  workflows: SyncedWorkflow[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Live view of the user's workflows (m13 Phase 8). Built-ins and
 * user-authored rows both sync; the caller decides which to show where.
 * Rows that fail schema validation are dropped rather than crashing the
 * page.
 */
export function useWorkflows(): WorkflowsState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [workflows, setWorkflows] = useState<SyncedWorkflow[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setWorkflows(null);
      return;
    }
    const prefix = IDB_KEY.WORKFLOW({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedWorkflow[] = [];
        for (const value of values) {
          const result = syncedWorkflowSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort((a, b) => a.name.localeCompare(b.name));
        setWorkflows(parsed);
      },
    );
  }, [rep]);

  return {
    workflows: workflows ?? [],
    loading: workflows === null && !loadError,
    error: loadError,
    retry,
  };
}

export interface WorkflowState {
  workflow: SyncedWorkflow | null;
  /** Persist an edit; the server confirms on the next pull. */
  updateWorkflow: (args: Omit<WorkflowUpdateArgs, "slug">) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Live view of a single workflow by slug, with an update mutator bound to it. */
export function useWorkflow(slug: string): WorkflowState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [workflow, setWorkflow] = useState<SyncedWorkflow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!rep) {
      setWorkflow(null);
      setLoaded(false);
      return;
    }
    const key = IDB_KEY.WORKFLOW({ id: slug });
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.get(key),
      (value) => {
        const result = value ? syncedWorkflowSchema.safeParse(value) : null;
        setWorkflow(result?.success ? result.data : null);
        setLoaded(true);
      },
    );
  }, [rep, slug]);

  const updateWorkflow = useCallback(
    async (args: Omit<WorkflowUpdateArgs, "slug">): Promise<void> => {
      if (!rep) return;
      await rep.mutate.workflowUpdate({ slug, ...args });
    },
    [rep, slug],
  );

  return {
    workflow,
    updateWorkflow,
    loading: !loaded && !loadError,
    error: loadError,
    retry,
  };
}
