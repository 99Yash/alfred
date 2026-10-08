import { SYNC_MODEL, type SyncedArtifact } from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { useReplicache, useReplicacheStatus } from "./context";

export interface RecentArtifactsState {
  /** Newest first. */
  artifacts: SyncedArtifact[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

/** A recent feed, not an archive: the server syncs only the newest 200 artifacts. */
export function useRecentArtifacts(): RecentArtifactsState {
  const { rep, loadError, pullError, initialPullPending, retry } = useReplicacheStatus();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    rows: SyncedArtifact[];
  } | null>(null);

  useEffect(() => {
    if (!rep) {
      setSnapshot(null);

      return;
    }

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.artifact.scan(tx),
      (rows) => {
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setSnapshot({ rep, rows });
      },
    );
  }, [rep]);

  const current = snapshot?.rep === rep ? snapshot.rows : null;
  const error = loadError ?? pullError;

  return {
    artifacts: current ?? [],
    loading: !error && (current === null || (current.length === 0 && initialPullPending)),
    error,
    initialPullPending,
    retry,
  };
}

/** One thread's artifacts (ADR-0075), newest first. */
export function useThreadArtifacts(threadId: string | undefined): SyncedArtifact[] {
  const rep = useReplicache();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    threadId: string;
    rows: SyncedArtifact[];
  } | null>(null);

  useEffect(() => {
    if (!rep || !threadId) return;

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.artifact.scan(tx),
      (values) => {
        const rows = values.filter((value) => value.threadId === threadId);
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setSnapshot({ rep, threadId, rows });
      },
    );
  }, [rep, threadId]);

  return snapshot?.rep === rep && snapshot.threadId === threadId ? snapshot.rows : [];
}

/** Null until the artifact syncs. */
export function useArtifact(artifactId: string | undefined): SyncedArtifact | null {
  const rep = useReplicache();

  const [snapshot, setSnapshot] = useState<{
    rep: Replicache<ClientMutators>;
    artifactId: string;
    artifact: SyncedArtifact | null;
  } | null>(null);

  useEffect(() => {
    if (!rep || !artifactId) return;

    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.artifact.get(tx, { id: artifactId }),
      (artifact) => setSnapshot({ rep, artifactId, artifact }),
    );
  }, [rep, artifactId]);

  return snapshot?.rep === rep && snapshot.artifactId === artifactId ? snapshot.artifact : null;
}
