import type { TriageCategory } from "@alfred/contracts";
import { SYNC_MODEL, type SyncedTriageTag } from "@alfred/sync";
import { useCallback, useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

const EMPTY_TRIAGE_TAGS: ReadonlyMap<string, SyncedTriageTag> = new Map();

export interface TriageTagsState {
  tagsByThreadId: ReadonlyMap<string, SyncedTriageTag>;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Pin a Gmail thread to a user-chosen triage category. Optimistic. */
  overrideTag: (threadId: string, category: TriageCategory) => Promise<void>;
}

/**
 * Live view of synced triage tags (rfc-triage-tags.md). Rows are keyed by Gmail
 * thread id so inbox rows can join them without a separate API lookup.
 */
export function useTriageTags(): TriageTagsState {
  const { rep, loadError, retry } = useReplicacheStatus();
  const [tagsByThreadId, setTagsByThreadId] = useState<ReadonlyMap<string, SyncedTriageTag> | null>(
    null,
  );

  useEffect(() => {
    if (!rep) {
      setTagsByThreadId(null);
      return;
    }
    return rep.subscribe(
      (tx: ReadTransaction) => SYNC_MODEL.triagetag.scan(tx),
      (tags) => {
        const next = new Map<string, SyncedTriageTag>();
        for (const tag of tags) {
          next.set(tag.threadId, tag);
        }
        setTagsByThreadId(next);
      },
    );
  }, [rep]);

  const overrideTag = useCallback(
    async (threadId: string, category: TriageCategory): Promise<void> => {
      if (!rep || !threadId) return;
      await rep.mutate.triageTagOverride({ threadId, category });
    },
    [rep],
  );

  return {
    tagsByThreadId: tagsByThreadId ?? EMPTY_TRIAGE_TAGS,
    loading: tagsByThreadId == null && !loadError,
    error: loadError,
    retry,
    overrideTag,
  };
}
