import { SYNC_MODEL, type SyncedArtifact } from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction, Replicache } from "replicache";
import type { ClientMutators } from "@alfred/sync";
import { useReplicache, useReplicacheStatus } from "./context";

export interface RecentArtifactsState {
  /** The artifacts present in the bounded Replicache sync window, newest first. */
  artifacts: SyncedArtifact[];
  loading: boolean;
  error: string | null;
  initialPullPending: boolean;
  retry: () => void;
}

/**
 * Reactive global artifact list. The server syncs at most the newest 200
 * artifacts, so this is intentionally a recent feed rather than a full archive.
 */
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

/**
 * Reactive list of one thread's agent-produced artifacts (ADR-0075), newest
 * first. Mirrors `useChatMessages` — scan the flat `artifact/` prefix,
 * zod-validate each row, filter by threadId client-side. Empty for a thread
 * the boss hasn't authored an artifact in.
 */
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

/**
 * Reactive single-artifact lookup by id — the sidebar reads the selected
 * artifact through this. Returns null while it hasn't synced yet.
 */
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
