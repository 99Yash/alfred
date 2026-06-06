import { IDB_KEY, type SyncedBriefing, syncedBriefingSchema } from "@alfred/sync";
import { useEffect, useState } from "react";
import type { ReadTransaction } from "replicache";
import { useReplicacheStatus } from "./context";

/** morning reads above evening within a day (orientation → close, ADR-0049). */
const SLOT_ORDER: Record<string, number> = { morning: 0, evening: 1 };

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
  const { rep, loadError, retry } = useReplicacheStatus();
  const [briefings, setBriefings] = useState<SyncedBriefing[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setBriefings(null);
      return;
    }
    const prefix = IDB_KEY.BRIEFING({});
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedBriefing[] = [];
        for (const value of values) {
          const result = syncedBriefingSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort((a, b) => {
          if (a.briefingDate !== b.briefingDate)
            return b.briefingDate.localeCompare(a.briefingDate);
          return compareSlots(a, b);
        });
        setBriefings(parsed);
      },
    );
  }, [rep]);

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
  const { rep, loadError, retry } = useReplicacheStatus();
  const [slots, setSlots] = useState<SyncedBriefing[] | null>(null);

  useEffect(() => {
    if (!rep) {
      setSlots(null);
      return;
    }
    const prefix = IDB_KEY.BRIEFING({ id: `${date}/` });
    return rep.subscribe(
      async (tx: ReadTransaction) => tx.scan({ prefix }).values().toArray(),
      (values) => {
        const parsed: SyncedBriefing[] = [];
        for (const value of values) {
          const result = syncedBriefingSchema.safeParse(value);
          if (result.success) parsed.push(result.data);
        }
        parsed.sort(compareSlots);
        setSlots(parsed);
      },
    );
  }, [rep, date]);

  return {
    slots: slots ?? [],
    loading: slots === null && !loadError,
    error: loadError,
    retry,
  };
}
