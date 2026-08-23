import { IDB_KEY, type SyncedBriefing, syncedBriefingSchema } from "@alfred/sync";
import { useCallback } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";
import { useReplicacheSubscription } from "./use-replicache-subscription";

/** morning reads above evening within a day (orientation → close, ADR-0049). */
const SLOT_ORDER: Record<string, number> = { morning: 0, evening: 1 };

function compareSlots(a: SyncedBriefing, b: SyncedBriefing): number {
  return (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9);
}

function parseBriefingRows(values: unknown[]): SyncedBriefing[] {
  const parsed: SyncedBriefing[] = [];
  for (const value of values) {
    const result = syncedBriefingSchema.safeParse(value);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
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
  const prefix = IDB_KEY.BRIEFING({});
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
  const prefix = IDB_KEY.BRIEFING({ id: `${date}/` });
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
