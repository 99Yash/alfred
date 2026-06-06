import type { TriageCategory } from "@alfred/contracts";
import { IDB_KEY, syncedTriageTagSchema, type SyncedTriageTag } from "@alfred/sync";
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
    const prefix = IDB_KEY.TRIAGE_TAG({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const next = new Map<string, SyncedTriageTag>();
        for (const value of values) {
          const result = syncedTriageTagSchema.safeParse(value);
          if (result.success) next.set(result.data.threadId, result.data);
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
