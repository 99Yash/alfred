import { SYNC_MODEL, type SyncedArtifact } from "@alfred/sync";
import { useCallback, useMemo } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheSubscription } from "./use-replicache-subscription";

export interface RecentArtifactsState {
  /** Newest first. */
  artifacts: SyncedArtifact[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

const scanArtifacts = (tx: ReadTransaction) => SYNC_MODEL.artifact.scan(tx);

const newestFirst = (rows: SyncedArtifact[]) =>
  rows.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

/** A recent feed, not an archive: the server syncs only the newest 200 artifacts. */
export function useRecentArtifacts(): RecentArtifactsState {
  const { data, loading, error, initialPullPending, retry } = useReplicacheSubscription(
    scanArtifacts,
    newestFirst,
  );

  return { artifacts: data ?? [], loading, error, initialPullPending, retry };
}

/** One thread's artifacts (ADR-0075), newest first. */
export function useThreadArtifacts(threadId: string | undefined): SyncedArtifact[] {
  const selectThread = useCallback(
    (rows: SyncedArtifact[]) => newestFirst(rows.filter((row) => row.threadId === threadId)),
    [threadId],
  );

  return useReplicacheSubscription(threadId ? scanArtifacts : null, selectThread).data ?? [];
}

/** Null until the artifact syncs. */
export function useArtifact(artifactId: string | undefined): SyncedArtifact | null {
  const query = useMemo(
    () =>
      artifactId ? (tx: ReadTransaction) => SYNC_MODEL.artifact.get(tx, { id: artifactId }) : null,
    [artifactId],
  );

  return useReplicacheSubscription(query).data ?? null;
}
