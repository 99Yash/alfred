import { SYNC_MODEL, type SyncedBriefing, syncedBriefingSchema } from "@alfred/sync";
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

function parseBriefingRows(values: unknown[]): SyncedBriefing[] {
  const rows: SyncedBriefing[] = [];
  for (const value of values) {
    const parsed = syncedBriefingSchema.safeParse(value);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
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
  const prefix = SYNC_MODEL.briefing.prefix;
  const query = useCallback(
    (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
    [prefix],
  );
  const briefings = useReplicacheSubscription<unknown[], SyncedBriefing[]>(
    query,
    useCallback((values: unknown[]) => {
      const parsed = parseBriefingRows(values);
      parsed.sort((a, b) => {
        if (a.briefingDate !== b.briefingDate) return b.briefingDate.localeCompare(a.briefingDate);
        return compareSlots(a, b);
      });
      return parsed;
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
  const prefix = SYNC_MODEL.briefing.storageKeyForId(`${date}/`);
  const query = useCallback(
    (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
    [prefix],
  );
  const slots = useReplicacheSubscription<unknown[], SyncedBriefing[]>(
    query,
    useCallback((values: unknown[]) => {
      const parsed = parseBriefingRows(values);
      parsed.sort(compareSlots);
      return parsed;
    }, []),
  );

  return {
    slots: slots ?? [],
    loading: slots === null && !loadError,
    error: loadError,
    retry,
  };
}
