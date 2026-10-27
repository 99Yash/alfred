import type { TriageCategory } from "@alfred/contracts";
import { SYNC_MODEL, type SyncedTriageTag } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicache } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

const EMPTY_TRIAGE_TAGS: ReadonlyMap<string, SyncedTriageTag> = new Map();

function scanTriageTags(tx: ReadTransaction): Promise<SyncedTriageTag[]> {
  return SYNC_MODEL.triagetag.scan(tx);
}

function byThreadId(tags: SyncedTriageTag[]): ReadonlyMap<string, SyncedTriageTag> {
  const next = new Map<string, SyncedTriageTag>();

  for (const tag of tags) {
    next.set(tag.threadId, tag);
  }

  return next;
}

export interface TriageTagsState {
  tagsByThreadId: ReadonlyMap<string, SyncedTriageTag>;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Pin a Gmail thread to a category the user picks. */
  overrideTag: (threadId: string, category: TriageCategory) => Promise<void>;
}

/** Synced triage tags (docs/rfc-triage-tags.md), keyed by Gmail thread id. */
export function useTriageTags(): TriageTagsState {
  const rep = useReplicache();
  const { data, loading, error, retry } = useReplicacheSubscription(scanTriageTags, byThreadId);

  const overrideTag = useCallback(
    async (threadId: string, category: TriageCategory): Promise<void> => {
      if (!rep || !threadId) return;
      await rep.mutate.triageTagOverride({ threadId, category });
    },
    [rep],
  );

  return {
    tagsByThreadId: data ?? EMPTY_TRIAGE_TAGS,
    loading,
    error,
    retry,
    overrideTag,
  };
}
