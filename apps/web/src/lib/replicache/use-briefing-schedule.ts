import {
  briefingHourSchema,
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_EVENING_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
} from "@alfred/contracts/briefing-constants";
import { isIanaTimezone } from "@alfred/contracts";
import { useMemo } from "react";
import { usePreferenceMap } from "./use-preferences";

const BRIEFING_PREF_KEYS = {
  // The one zone for chat dates and briefing delivery. `briefing.timezone` is a read-only fallback.
  timezone: "timezone",
  morningHour: "briefing.delivery_hour",
  eveningHour: "briefing.evening_hour",
} as const;

const LEGACY_TIMEZONE_KEY = "briefing.timezone";

export interface BriefingScheduleState {
  /** Stored value, else the server default. */
  timezone: string;
  /** Hour 0–23 in `timezone`. */
  morningHour: number;
  eveningHour: number;
  /** The field uses a stored value, not the default. */
  hasOverride: { timezone: boolean; morningHour: boolean; eveningHour: boolean };
  setTimezone: (tz: string) => Promise<void>;
  setMorningHour: (hour: number) => Promise<void>;
  setEveningHour: (hour: number) => Promise<void>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

function parseHour(value: unknown): number | null {
  const result = briefingHourSchema.safeParse(value);

  return result.success ? result.data : null;
}

function parseTimezone(value: unknown): string | null {
  return isIanaTimezone(value) ? value : null;
}

/** The briefing schedule from preference rows. A missing row means the server default. */
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
