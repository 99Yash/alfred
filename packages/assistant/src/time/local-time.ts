/**
 * The one home for "which calendar day is it in this zone" and "what is the UTC
 * offset now". Do not write `Intl` date code at call sites.
 * - A {@link LocalDateKey} is a day with no instant. Day math happens on keys,
 *   never in milliseconds, so DST cannot shift the day.
 * - An instant needs a zone to read: {@link inZone} binds it.
 * Zone-free key helpers are free functions: {@link addDays}, {@link weekdayIndex},
 * {@link formatDay}.
 */

import { type IanaTimezone } from "@alfred/contracts";

// ─── The local date key ───────────────────────────────────────────────────

declare const localDateKeyBrand: unique symbol;

/**
 * A calendar day with no instant or zone: `"2026-06-11"`. Branded so a key and
 * a zone cannot swap places (before, `localStartOfDay(timezone, key)` compiled). Strings from storage or the wire enter through
 * {@link parseLocalDateKey} or {@link isLocalDateKey}.
 */
export type LocalDateKey = string & { readonly [localDateKeyBrand]: true };

const LOCAL_DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse an untrusted string into a {@link LocalDateKey}, or throw.
 * Rejects a bad shape and a day that does not exist (`"2026-02-30"`), which
 * `Date.UTC` would silently roll over.
 */
export function parseLocalDateKey(value: string): LocalDateKey {
  const match = LOCAL_DATE_KEY_RE.exec(value);

  if (!match) {
    throw new Error(`[timezone] not a local date key (expected YYYY-MM-DD): ${value}`);
  }

  const [, year, month, day] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  if (utc.toISOString().slice(0, 10) !== value) {
    throw new Error(`[timezone] not a real calendar day: ${value}`);
  }

  // SAFETY: the regex and the round-trip above prove a real YYYY-MM-DD day.
  return value as LocalDateKey;
}

/** Non-throwing {@link parseLocalDateKey}. A bare `\d{4}-\d{2}-\d{2}` regex accepts `"2026-02-30"`. */
export function isLocalDateKey(value: unknown): value is LocalDateKey {
  if (typeof value !== "string") return false;

  try {
    parseLocalDateKey(value);

    return true;
  } catch {
    return false;
  }
}

/** No fallbacks: the key is valid by its brand. */
function dateParts(key: LocalDateKey): [year: number, monthIndex: number, day: number] {
  const [year, month, day] = key.split("-");

  return [Number(year), Number(month) - 1, Number(day)];
}

/** Noon UTC on the key. No offset can push noon into a neighbouring day. */
function noonUtcOn(key: LocalDateKey): Date {
  return new Date(Date.UTC(...dateParts(key), 12));
}

// ─── Formatters ───────────────────────────────────────────────────────────

/**
 * A locale and options pair. The formatter cache keys on the recipe object, so
 * a key cannot point at the wrong options. `Intl.DateTimeFormat` is expensive
 * to build. Decisions never read formatted text: use {@link weekdayIndex}.
 */
interface FormatRecipe {
  readonly locale: string;
  readonly options: Readonly<Intl.DateTimeFormatOptions>;
}

const formatterCache = new WeakMap<FormatRecipe, Map<string, Intl.DateTimeFormat>>();

function formatterFor(recipe: FormatRecipe, timeZone: string): Intl.DateTimeFormat {
  let byZone = formatterCache.get(recipe);

  if (!byZone) {
    byZone = new Map();
    formatterCache.set(recipe, byZone);
  }

  let formatter = byZone.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(recipe.locale, { ...recipe.options, timeZone });
    byZone.set(timeZone, formatter);
  }

  return formatter;
}

/** Throw on a missing part. A `"--"` date would reach the model as fact. */
function requirePart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
  timezone: string,
): string {
  const value = parts.find((part) => part.type === type)?.value;

  if (!value) {
    throw new Error(`[timezone] Intl returned no ${type} part for tz=${timezone}`);
  }

  return value;
}

/** `sv-SE` formats dates as `YYYY-MM-DD`. */
const DAY_KEY_RECIPE: FormatRecipe = {
  locale: "sv-SE",
  options: { year: "numeric", month: "2-digit", day: "2-digit" },
};

const HOUR_RECIPE: FormatRecipe = {
  locale: "en-US",
  options: { hour: "numeric", hour12: false },
};

const OFFSET_RECIPE: FormatRecipe = {
  locale: "en-US",
  options: { timeZoneName: "longOffset" },
};

const INSTANT_RECIPE: FormatRecipe = {
  locale: "en-US",
  options: {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  },
};

/** `en-CA` with `h23` gives zero-padded numeric parts in every field. */
const WALL_CLOCK_RECIPE: FormatRecipe = {
  locale: "en-CA",
  options: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  },
};

// ─── Day-key operations: no zone, by construction ─────────────────────────

/** Shift a local date key by whole calendar days. */
export function addDays(key: LocalDateKey, days: number): LocalDateKey {
  const next = noonUtcOn(key);
  next.setUTCDate(next.getUTCDate() + days);

  // SAFETY: the first ten chars of an ISO instant are YYYY-MM-DD.
  return next.toISOString().slice(0, 10) as LocalDateKey;
}

/**
 * `0` = Sunday ... `6` = Saturday. Use this for weekday decisions, never a
 * formatted weekday name: a locale change would silently break the check.
 */
export function weekdayIndex(key: LocalDateKey): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  // SAFETY: getUTCDay returns 0-6 by spec.
  return noonUtcOn(key).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * - `short`: `"Jun 11"`.
 * - `long`: `"Wednesday, 10 June 2026"`.
 * - `weekday`: `"Wednesday"`, for display only.
 */
export type LocalDayStyle = "short" | "long" | "weekday";

const DAY_STYLE_RECIPES = {
  short: { locale: "en-US", options: { month: "short", day: "numeric" } },
  long: {
    locale: "en-GB",
    options: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  },
  weekday: { locale: "en-GB", options: { weekday: "long" } },
} satisfies Record<LocalDayStyle, FormatRecipe>;

/**
 * Render a key in UTC, with no zone parameter. Projecting a key through a zone
 * once showed a UTC+14 user's weekday a day late.
 */
export function formatDay(key: LocalDateKey, style: LocalDayStyle): string {
  return formatterFor(DAY_STYLE_RECIPES[style], "UTC").format(noonUtcOn(key));
}

// ─── The zone clock: every reading that needs a zone ──────────────────────

/** Every field the `system.current_time` tool reports. */
export interface LocalWallClock {
  localDate: LocalDateKey;
  /** 24-hour `HH:MM:SS`. */
  localTime: string;
  /** `"Monday"`. */
  weekday: string;
  /** `"+05:30"`. */
  utcOffset: string;
}

/** Zone-bound readings from {@link inZone}. `at` defaults to now. */
export interface ZoneClock {
  readonly timezone: IanaTimezone;

  /** Re-parsed, not cast, so an ICU change throws instead of corrupting keys. */
  day(at?: Date): LocalDateKey;

  /** 0-23. */
  hour(at?: Date): number;

  /** The only parser of the `longOffset` string. */
  offsetMs(at?: Date): number;

  clock(at?: Date): LocalWallClock;

  /**
   * UTC instant where `hour:00` starts on `day`. Iterates, because the offset
   * depends on the answer across DST. Three passes suffice for every real zone.
   */
  startOf(day: LocalDateKey, hour?: number): Date;

  /**
   * `[start, end)` of the day holding `at`. Each bound uses its own offset, so a
   * DST day is 23h or 25h. `now + 86_400_000` gets this wrong.
   */
  dayBounds(at?: Date): { start: Date; end: Date };

  /** `"Mon, Jun 11, 3:04 PM"`. */
  format(at: Date): string;
}

// Declared before `inZone` to avoid the temporal dead zone. Bounded by the IANA zone count.
const clockCache = new Map<IanaTimezone, ZoneClock>();

/** Bind a zone. Memoized per zone and holds nothing that expires, so call it inline. */
export function inZone(timezone: IanaTimezone): ZoneClock {
  const cached = clockCache.get(timezone);

  if (cached) return cached;
  const clock = bindZone(timezone);
  clockCache.set(timezone, clock);

  return clock;
}

function bindZone(timezone: IanaTimezone): ZoneClock {
  const day = (at: Date = new Date()): LocalDateKey =>
    parseLocalDateKey(formatterFor(DAY_KEY_RECIPE, timezone).format(at));

  const offsetMs = (at: Date = new Date()): number => {
    const value = requirePart(
      formatterFor(OFFSET_RECIPE, timezone).formatToParts(at),
      "timeZoneName",
      timezone,
    );

    // `longOffset` yields "GMT-05:00" / "GMT+05:45" / a bare "GMT" for UTC.
    const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(value);

    if (!match?.groups?.sign) return 0;

    const sign = match.groups.sign === "-" ? -1 : 1;
    const hours = Number(match.groups.hours);
    const minutes = Number(match.groups.minutes ?? "0");

    return sign * (hours * 60 + minutes) * 60_000;
  };

  const startOf = (key: LocalDateKey, hour = 0): Date => {
    const wallClockMs = Date.UTC(...dateParts(key), hour);
    let candidate = new Date(wallClockMs);

    for (let i = 0; i < 3; i += 1) {
      candidate = new Date(wallClockMs - offsetMs(candidate));
    }

    return candidate;
  };

  return {
    timezone,
    day,
    offsetMs,
    startOf,

    hour: (at: Date = new Date()): number => {
      const parts = formatterFor(HOUR_RECIPE, timezone).formatToParts(at);
      // Some engines emit "24" at midnight.
      const value = Number(requirePart(parts, "hour", timezone));

      return value === 24 ? 0 : value;
    },

    clock: (at: Date = new Date()): LocalWallClock => {
      const parts = formatterFor(WALL_CLOCK_RECIPE, timezone).formatToParts(at);

      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        requirePart(parts, type, timezone);

      return {
        localDate: parseLocalDateKey(`${part("year")}-${part("month")}-${part("day")}`),
        localTime: `${part("hour")}:${part("minute")}:${part("second")}`,
        weekday: part("weekday"),
        utcOffset: isoOffset(offsetMs(at)),
      };
    },

    dayBounds: (at: Date = new Date()) => {
      const today = day(at);

      return { start: startOf(today), end: startOf(addDays(today, 1)) };
    },

    format: (at: Date): string => formatterFor(INSTANT_RECIPE, timezone).format(at),
  };
}

/** `"+05:30"`, `"-04:00"`. */
function isoOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const totalMinutes = Math.abs(offsetMs) / 60_000;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
