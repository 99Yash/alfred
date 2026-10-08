import { SYNC_MODEL, type SyncedBriefing } from "@alfred/sync";
import type { BriefingSlot } from "@alfred/contracts";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

/** Morning before evening; unknown slots last. */
const SLOT_ORDER = {
  morning: 0,
  evening: 1,
} as const satisfies Record<BriefingSlot, number>;

function compareSlots(a: SyncedBriefing, b: SyncedBriefing): number {
  return (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9);
}

export interface BriefingsState {
  /** Newest day first; morning above evening. */
  briefings: SyncedBriefing[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Synced briefings (ADR-0049), a 30-day window. Read-only: the workflow is the only writer. */
export function useBriefings(): BriefingsState {
  const { loadError, retry } = useReplicacheStatus();
  const query = useCallback((tx: ReadTransaction) => SYNC_MODEL.briefing.scan(tx), []);

  const briefings = useReplicacheSubscription<SyncedBriefing[], SyncedBriefing[]>(
    query,
    useCallback((rows: SyncedBriefing[]) => {
      rows.sort((a, b) => {
        if (a.briefingDate !== b.briefingDate) return b.briefingDate.localeCompare(a.briefingDate);

        return compareSlots(a, b);
      });

      return rows;
    }, []),
  );

  return {
    briefings: briefings ?? [],
    loading: briefings === null && !loadError,
    error: loadError,
    retry,
  };
}

export interface BriefingDayState {
  /** Morning above evening. */
  slots: SyncedBriefing[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/** Both slots of one `YYYY-MM-DD` day. */
export function useBriefing(date: string): BriefingDayState {
  const { loadError, retry } = useReplicacheStatus();

  const query = useCallback(
    (tx: ReadTransaction) => SYNC_MODEL.briefing.scanPrefix(tx, { briefingDate: date }),
    [date],
  );

  const slots = useReplicacheSubscription<SyncedBriefing[], SyncedBriefing[]>(
    query,
    useCallback((rows: SyncedBriefing[]) => {
      rows.sort(compareSlots);

      return rows;
    }, []),
  );

  return {
    slots: slots ?? [],
    loading: slots === null && !loadError,
    error: loadError,
    retry,
  };
}
