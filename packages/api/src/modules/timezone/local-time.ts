/**
 * The one home for the two concepts this module owns: **"which calendar day is
 * it in this zone"** and **"what is the UTC offset at this instant"**. Every
 * locale trick, DST edge, and memoized `Intl` formatter in the API lives here —
 * `packages/api/CLAUDE.md` forbids per-call-site `Intl` glue, and the reason is
 * that the hand-rolls diverge: three different locale hacks for the same day
 * key, and a triage date that came out a day early because it read
 * `getUTCDate()` on the user's evening mail.
 *
 * Two representations, deliberately distinct:
 *   - a **local date key** (`"2026-06-11"`) — a calendar day with no instant.
 *     Day arithmetic ({@link addLocalDays}) happens here, never in milliseconds,
 *     so a DST transition can't shift the day.
 *   - an **instant** (`Date`) — a point in time. Rendering it needs a zone.
 */

// Constructing an `Intl.DateTimeFormat` allocates dozens of objects per locale
// lookup, and these run per request (`dayBoundsInTimezone`) and three times per
// converge loop (`localTimeInTimezone`). Memoize by zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, build: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = build();
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Local-date key (`YYYY-MM-DD`) for `instant` in `timezone`. The day-segment of
 * the briefing idempotency key, so the same machine-day in a user's zone never
 * sends twice.
 *
 * `sv-SE` formats dates as `YYYY-MM-DD` natively — the shortest path to a
 * stable ISO-style day key in any zone.
 */
export function localDateInTimezone(timezone: string, instant: Date = new Date()): string {
  return cachedFormatter(
    `date:${timezone}`,
    () =>
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
  ).format(instant);
}

/** 0–23 hour-of-day in `timezone` at `instant`. */
export function localHourInTimezone(timezone: string, instant: Date = new Date()): number {
  const parts = cachedFormatter(
    `hour:${timezone}`,
    () => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }),
  ).formatToParts(instant);
  const hour = parts.find((part) => part.type === "hour")?.value;
  if (!hour) {
    throw new Error(`[timezone] could not extract hour from tz=${timezone}`);
  }
  // `hour: 'numeric'` with `hour12: false` returns "0".."23"; some engines emit
  // "24" at midnight. Normalize.
  const n = Number(hour);
  return n === 24 ? 0 : n;
}

/**
 * Signed offset from UTC, in milliseconds, that `timezone` was at `instant`.
 * The only place the `longOffset` string is parsed — {@link formatUtcOffset}
 * and the day-boundary converge loop both derive from this one reader.
 */
export function offsetMsAt(instant: Date, timezone: string): number {
  const value =
    cachedFormatter(
      `offset:${timezone}`,
      () => new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }),
    )
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  // `longOffset` yields "GMT-05:00" / "GMT+05:45" / a bare "GMT" for UTC.
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(value);
  if (!match?.groups?.sign) return 0;

  const sign = match.groups.sign === "-" ? -1 : 1;
  const hours = Number(match.groups.hours);
  const minutes = Number(match.groups.minutes ?? "0");
  return sign * (hours * 60 + minutes) * 60_000;
}

/** The offset at `instant` as a signed ISO fragment (`"+05:30"`, `"-04:00"`). */
export function formatUtcOffset(instant: Date, timezone: string): string {
  const offsetMs = offsetMsAt(instant, timezone);
  const sign = offsetMs < 0 ? "-" : "+";
  const totalMinutes = Math.abs(offsetMs) / 60_000;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The UTC instant at which `localDate` begins in `timezone`. */
export function localStartOfDay(localDate: string, timezone: string): Date {
  return localTimeInTimezone(localDate, 0, timezone);
}

/**
 * The UTC instant of `hour:00` local time on `localDate` in `timezone`. The
 * offset depends on the answer (it changes across a DST boundary), so converge:
 * three passes is enough for every real zone.
 */
export function localTimeInTimezone(localDate: string, hour: number, timezone: string): Date {
  let candidate = new Date(Date.UTC(...dateParts(localDate), hour));
  for (let i = 0; i < 3; i += 1) {
    candidate = new Date(Date.UTC(...dateParts(localDate), hour) - offsetMsAt(candidate, timezone));
  }
  return candidate;
}

/**
 * `[startOfDay, endOfDay)` for the calendar day containing `instant` in
 * `timezone`, as UTC instants. Each bound converges on *its own* offset, so a
 * DST transition day correctly yields a 23h or 25h window.
 */
export function dayBoundsInTimezone(instant: Date, timezone: string): { start: Date; end: Date } {
  const today = localDateInTimezone(timezone, instant);
  return {
    start: localStartOfDay(today, timezone),
    end: localStartOfDay(addLocalDays(today, 1), timezone),
  };
}

/** Shift a local date key by whole calendar days. Zone-free by construction. */
export function addLocalDays(localDate: string, days: number): string {
  const next = new Date(Date.UTC(...dateParts(localDate), 12));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** Render an instant in `timezone` as `"Mon, Jun 11, 3:04 PM"`. */
export function formatInstantInTimezone(instant: Date | null, timezone: string): string | null {
  if (!instant) return null;
  return cachedFormatter(
    `instant:${timezone}`,
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
  ).format(instant);
}

/**
 * Render a local date key as a terse `"Jun 11"` fragment — the shape a rail
 * todo's `assist` line carries. Takes a key, not an instant, because the caller
 * has already decided which calendar day it means.
 */
export function formatLocalDayShort(localDate: string): string {
  return cachedFormatter(
    "dayShort",
    () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }),
  ).format(noonUtcOn(localDate));
}

/**
 * Render a local date key in long form — `"Wednesday, 10 June 2026"`, the shape
 * the agent's date grounding carries.
 *
 * Renders the key at noon UTC *in UTC*, never in a zone: a key is already a
 * calendar day, so re-projecting it through a zone is how a UTC+14 user's
 * weekday came out a day late.
 */
export function formatLocalDayLong(localDate: string): string {
  return cachedFormatter(
    "dayLong",
    () =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
  ).format(noonUtcOn(localDate));
}

/** Full weekday name for a local date key, e.g. `"Wednesday"`. */
export function formatLocalWeekday(localDate: string): string {
  return cachedFormatter(
    "weekday",
    () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }),
  ).format(noonUtcOn(localDate));
}

/** Wall-clock reading in a zone — every field the `system.current_time` tool reports. */
export interface LocalWallClock {
  /** Local date key, `YYYY-MM-DD`. */
  localDate: string;
  /** 24-hour local time, `HH:MM:SS`. */
  localTime: string;
  /** Full local weekday name, e.g. `"Monday"`. */
  weekday: string;
  /** Signed ISO offset at this instant, e.g. `"+05:30"`. */
  utcOffset: string;
}

/**
 * Read the full wall clock in `timezone` at `instant` in one pass. `en-CA` with
 * `hourCycle: "h23"` gives zero-padded numeric parts in every field, so the
 * date and time strings assemble without per-field locale guessing.
 */
export function localWallClockInTimezone(instant: Date, timezone: string): LocalWallClock {
  const parts = cachedFormatter(
    `wallClock:${timezone}`,
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        weekday: "long",
      }),
  ).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    localTime: `${part("hour")}:${part("minute")}:${part("second")}`,
    weekday: part("weekday"),
    utcOffset: formatUtcOffset(instant, timezone),
  };
}

/**
 * Midday UTC on a local date key — the anchor for rendering a key as prose.
 * Noon, not midnight, so no zone offset can push the instant into a
 * neighbouring day.
 */
function noonUtcOn(localDate: string): Date {
  return new Date(Date.UTC(...dateParts(localDate), 12));
}

function dateParts(localDate: string): [number, number, number] {
  const [year, month, day] = localDate.split("-").map(Number);
  return [year ?? 0, (month ?? 1) - 1, day ?? 1];
}
