import {
  SYNC_MODEL,
  type SyncedWorkflow,
  syncedWorkflowSchema,
  type WorkflowUpdateArgs,
} from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import type { ReplicacheSnapshot } from "./client";
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
  const [snapshot, setSnapshot] = useState<ReplicacheSnapshot<SyncedWorkflow[]> | null>(null);

  useEffect(() => {
    if (!rep) return;
    const prefix = SYNC_MODEL.WORKFLOW.prefix;
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedWorkflow[] = [];
        for (const value of values) {
          const result = syncedWorkflowSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort((a, b) => a.name.localeCompare(b.name));
        setSnapshot({ rep, value: parsed });
      },
    );
  }, [rep]);

  const workflows = snapshot?.rep === rep ? snapshot.value : null;
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
  updateWorkflow: (args: Omit<WorkflowUpdateArgs, "slug" | "expectedRowVersion">) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Live view of a single workflow by slug, with an update mutator bound to it. */
export function useWorkflow(slug: string): WorkflowState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    slug: string;
    workflow: SyncedWorkflow | null;
  } | null>(null);

  useEffect(() => {
    if (!rep) return;
    const key = SYNC_MODEL.WORKFLOW.storageKeyForId(slug);
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.get(key),
      (value) => {
        const result = value ? syncedWorkflowSchema.safeParse(value) : null;
        setSnapshot({ rep, slug, workflow: result?.success ? result.data : null });
      },
    );
  }, [rep, slug]);

  const current = snapshot?.rep === rep && snapshot.slug === slug ? snapshot : null;
  const updateWorkflow = useCallback(
    async (args: Omit<WorkflowUpdateArgs, "slug" | "expectedRowVersion">): Promise<void> => {
      if (!rep) return;
      const expectedRowVersion = current?.workflow?.rowVersion;
      if (expectedRowVersion === undefined) return;
      await rep.mutate.workflowUpdate({ slug, expectedRowVersion, ...args });
    },
    [current?.workflow?.rowVersion, rep, slug],
  );

  return {
    workflow: current?.workflow ?? null,
    updateWorkflow,
    loading: current === null && !loadError,
    error: loadError,
    retry,
  };
}
