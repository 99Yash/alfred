import {
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_EVENING_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
} from "@alfred/contracts/briefing-constants";
import { useMemo } from "react";
import { usePreferenceMap } from "./use-preferences";

const BRIEFING_PREF_KEYS = {
  // #229: `timezone` is the ONE canonical zone — it grounds chat/boss date
  // reasoning AND briefing delivery. The picker writes here; the legacy
  // `briefing.timezone` key is read-only fallback for rows written before the
  // unification (server resolvers honor the same precedence).
  timezone: "timezone",
  morningHour: "briefing.delivery_hour",
  eveningHour: "briefing.evening_hour",
} as const;

/** Legacy zone key, still read for display if no canonical row exists yet. */
const LEGACY_TIMEZONE_KEY = "briefing.timezone";

export interface BriefingScheduleState {
  /** Effective IANA timezone (stored value, else the server default). */
  timezone: string;
  /** Morning delivery hour 0–23 in `timezone` (stored value, else default). */
  morningHour: number;
  /** Evening delivery hour 0–23 in `timezone` (stored value, else default). */
  eveningHour: number;
  /** True once the stored value (not the default) is in effect for that field. */
  hasOverride: { timezone: boolean; morningHour: boolean; eveningHour: boolean };
  setTimezone: (tz: string) => Promise<void>;
  setMorningHour: (hour: number) => Promise<void>;
  setEveningHour: (hour: number) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

function parseHour(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

function parseTimezone(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Live view of the briefing delivery schedule (Settings → Features →
 * Briefing schedule). Reads the three `briefing.*` preference rows from the
 * same `pref/{key}` prefix the feature flags use; an absent row resolves to
 * the documented server default. Writes are optimistic `prefSet` mutations
 * that the next pull rebases — identical idiom to {@link useFeatureFlags}.
 */
export function useBriefingSchedule(): BriefingScheduleState {
  const { values, loaded, setPref, loadError, retry } = usePreferenceMap();

  const tzStored =
    parseTimezone(values[BRIEFING_PREF_KEYS.timezone]) ??
    parseTimezone(values[LEGACY_TIMEZONE_KEY]);
  const morningStored = parseHour(values[BRIEFING_PREF_KEYS.morningHour]);
  const eveningStored = parseHour(values[BRIEFING_PREF_KEYS.eveningHour]);

  const hasOverride = useMemo(
    () => ({
      timezone: tzStored !== null,
      morningHour: morningStored !== null,
      eveningHour: eveningStored !== null,
    }),
    [tzStored, morningStored, eveningStored],
  );

  return {
    timezone: tzStored ?? DEFAULT_BRIEFING_TIMEZONE,
    morningHour: morningStored ?? DEFAULT_BRIEFING_DELIVERY_HOUR,
    eveningHour: eveningStored ?? DEFAULT_BRIEFING_EVENING_HOUR,
    hasOverride,
    setTimezone: (tz) => setPref(BRIEFING_PREF_KEYS.timezone, tz),
    setMorningHour: (hour) => setPref(BRIEFING_PREF_KEYS.morningHour, hour),
    setEveningHour: (hour) => setPref(BRIEFING_PREF_KEYS.eveningHour, hour),
    loading: !loaded && !loadError,
    error: loadError,
    retry,
  };
}
