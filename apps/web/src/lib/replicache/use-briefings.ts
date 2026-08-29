import { SYNC_MODEL, type SyncedBriefing } from "@alfred/sync";
import type { BriefingSlot } from "@alfred/contracts";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

/** Rank for sort: morning (0) before evening (1); unknown slots sort last. */
const SLOT_ORDER = {
  morning: 0,
  evening: 1,
} as const satisfies Record<BriefingSlot, number>;

function compareSlots(a: SyncedBriefing, b: SyncedBriefing): number {
  return (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9);
}

export interface BriefingsState {
  /** All synced briefing rows, newest day first; morning above evening within a day. */
  briefings: SyncedBriefing[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Live, reverse-chronological view of the synced briefings (ADR-0049). Reads
 * the Replicache 30-day window only (≈60 rows at two slots/day); the workflow
 * is the sole writer, so there are no mutators here. Rows that fail schema
 * validation are dropped rather than crashing the page.
 */
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
  /** The day's slot rows (morning above evening). Empty when no row is synced. */
  slots: SyncedBriefing[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Live view of a single day's briefing(s) by `YYYY-MM-DD`. Prefix-scans
 * `briefing/{date}/` so both the morning and evening slot rows arrive together
 * and render stacked (ADR-0049). Read-only.
 */
export function useBriefing(date: string): BriefingDayState {
  const { loadError, retry } = useReplicacheStatus();
  const query = useCallback(
    (tx: ReadTransaction) => SYNC_MODEL.briefing.scan(tx, { idPrefix: `${date}/` }),
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
