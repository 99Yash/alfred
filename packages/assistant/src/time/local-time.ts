/**
 * The one home for the two concepts this module owns: **"which calendar day is
 * it in this zone"** and **"what is the UTC offset at this instant"**. Every
 * locale trick, DST edge, and memoized `Intl` formatter in the API lives here —
 * `packages/api/CLAUDE.md` forbids per-call-site `Intl` glue, and the reason is
 * that the hand-rolls diverge: three different locale hacks for the same day
 * key, and a triage date that came out a day early because it read
 * `getUTCDate()` on the user's evening mail.
 *
 * Two representations, deliberately distinct **and separately typed**:
 *   - a {@link LocalDateKey} (`"2026-06-11"`) — a calendar day with no instant.
 *     Day arithmetic ({@link addDays}) happens here, never in milliseconds, so a
 *     DST transition can't shift the day.
 *   - an **instant** (`Date`) — a point in time. Reading anything off it needs a
 *     zone, which is what {@link inZone} binds.
 *
 * That split is also the module's whole public shape, so a caller never has to
 * recall a name:
 *
 *   - **Needs a zone** → hangs off {@link inZone}. `inZone(tz).day()`,
 *     `.hour()`, `.dayBounds()`, `.startOf(day)`, `.clock()`, `.format(at)`.
 *     The zone binds once, so it stops being an argument — the previous shape
 *     was nine free functions, seven taking the zone last and two taking it
 *     first, which is how `localStartOfDay(timezone, key)` used to compile.
 *   - **Doesn't need a zone** → a free function on the key. {@link addDays},
 *     {@link weekdayIndex}, {@link formatDay}. A day key has no zone left to
 *     re-project through, and taking one is how a UTC+14 user's weekday came
 *     out a day late.
 *
 * Both the day key and the zone are branded, so the compiler — not the argument
 * name — decides which slot a value may occupy.
 */

import { type IanaTimezone } from "@alfred/contracts";

// ─── The local date key ───────────────────────────────────────────────────

declare const localDateKeyBrand: unique symbol;

/**
 * A calendar day, with no instant and no zone attached: `"2026-06-11"`.
 *
 * Branded because the un-branded version silently confused the two
 * representations. `localStartOfDay(timezone, key)` compiled — both parameters
 * were `string` and the order differed from its sibling `localDateInTimezone`
 * — and `dateParts("2026")` returned `[2026, 0, 1]`, so a truncated key became
 * a plausible wrong answer rather than an error.
 *
 * `inZone(tz).day()` and `inZone(tz).clock()` are the only minters. A plain
 * string arriving from persistence, a workflow's state, or a wire payload enters
 * through {@link parseLocalDateKey} or {@link isLocalDateKey}.
 */
export type LocalDateKey = string & { readonly [localDateKeyBrand]: true };

const LOCAL_DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse an untrusted string into a {@link LocalDateKey}, or throw.
 *
 * The gate for every day key that did not come from this module: persisted
 * workflow state, a `briefing_date` column, a validated request field. Rejects
 * both the wrong shape (`"2026"`, `"11/06/2026"`) and a well-formed day that
 * does not exist (`"2026-02-30"`) — `Date.UTC` rolls the latter over in
 * silence, which is the failure mode the brand exists to make impossible.
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
  return value as LocalDateKey;
}

/**
 * Whether `value` is a well-formed, existing calendar day in `YYYY-MM-DD` form.
 *
 * The same gate as {@link parseLocalDateKey} for the boundaries that must not
 * throw — a Zod `refine`, a filter over persisted rows. Reach for this instead
 * of re-writing `/^\d{4}-\d{2}-\d{2}$/`, which accepts `"2026-02-30"`.
 */
export function isLocalDateKey(value: unknown): value is LocalDateKey {
  if (typeof value !== "string") return false;
  try {
    parseLocalDateKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A key is validated at its minter, so the split is total and needs no
 * `?? 0` fallbacks — the ones this used to carry read as guards but caught
 * nothing, since `??` does not catch the `NaN` that `Number()` produces here.
 */
function dateParts(key: LocalDateKey): [year: number, monthIndex: number, day: number] {
  const [year, month, day] = key.split("-");
  return [Number(year), Number(month) - 1, Number(day)];
}

/**
 * Midday UTC on a local date key — the anchor for reading or rendering a key
 * without a zone. Noon, not midnight, so no offset on earth can push the
 * instant into a neighbouring day.
 */
function noonUtcOn(key: LocalDateKey): Date {
  return new Date(Date.UTC(...dateParts(key), 12));
}

// ─── Formatters ───────────────────────────────────────────────────────────

/**
 * A locale + options pair, declared once at module scope.
 *
 * Constructing an `Intl.DateTimeFormat` allocates dozens of objects per locale
 * lookup, and these run per request (`inZone(tz).dayBounds()`) and three times
 * per converge loop (`inZone(tz).startOf(day)`), so they are memoized. The cache
 * is keyed by the recipe **object** rather than by a hand-written string: a key
 * like `"dayShort"` or `` `date:${tz}` `` has no enforced relationship to the
 * options it stands for, so a later entry could reuse one and get back a
 * formatter built from different options. Object identity cannot drift from what
 * it identifies.
 *
 * Keeping the recipes in one table is also the only place the locale choices
 * are comparable. They are not interchangeable — `sv-SE` is the ISO-shaped day
 * key, `en-GB` is day-month-year prose, `en-US` is the terse `Jun 11` a rail
 * todo carries — and the table is what makes a divergence visible instead of
 * hiding one per function. Weekday *logic* never reads these: see
 * {@link weekdayIndex}.
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

/**
 * Read one `formatToParts` field, or throw.
 *
 * One posture for a missing part, everywhere in this module. The alternative —
 * substituting `""` — assembled `"--"` for a date and `"::"` for a time and
 * handed them to `system.current_time` and the agent's `<runtime_context>`
 * line, where a malformed clock string is strictly worse than a failure the
 * run can surface: the model reads it verbatim and reasons from it.
 */
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

/** `sv-SE` formats dates as `YYYY-MM-DD` natively — the shortest path to a stable day key. */
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

/**
 * `en-CA` with `hourCycle: "h23"` gives zero-padded numeric parts in every
 * field, so the date and time strings assemble without per-field locale
 * guessing.
 */
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
  return next.toISOString().slice(0, 10) as LocalDateKey;
}

/**
 * Day-of-week for a local date key, `0` = Sunday … `6` = Saturday.
 *
 * The reading every weekend/weekday *decision* uses. Deriving one from a
 * formatted weekday name — `formatDay(key, "weekday") === "Saturday"` — couples
 * a policy to a locale choice in another file, where changing the locale looks
 * cosmetic and silently breaks the decision.
 */
export function weekdayIndex(key: LocalDateKey): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return noonUtcOn(key).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * How to render a {@link LocalDateKey} as prose. A closed set, so adding the
 * next presentation is one entry in {@link DAY_STYLE_RECIPES} and an unhandled
 * one is a type error — where three separate `formatLocalDay*` exports grew a
 * new name per call site instead.
 *
 * - `short` — `"Jun 11"`, the fragment a rail todo's `assist` line carries.
 * - `long` — `"Wednesday, 10 June 2026"`, the agent's date grounding.
 * - `weekday` — `"Wednesday"`, for display only; decisions use
 *   {@link weekdayIndex}.
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
 * Render a local date key as prose in the given style.
 *
 * Renders the key at noon UTC *in UTC*, and takes no zone at all: a key is
 * already a calendar day, so re-projecting it through a zone is how a UTC+14
 * user's weekday came out a day late. Not having the parameter is what makes
 * that unrepresentable rather than merely documented.
 */
export function formatDay(key: LocalDateKey, style: LocalDayStyle): string {
  return formatterFor(DAY_STYLE_RECIPES[style], "UTC").format(noonUtcOn(key));
}

// ─── The zone clock: every reading that needs a zone ──────────────────────

/** Wall-clock reading in a zone — every field the `system.current_time` tool reports. */
export interface LocalWallClock {
  /** Local date key, `YYYY-MM-DD`. */
  localDate: LocalDateKey;
  /** 24-hour local time, `HH:MM:SS`. */
  localTime: string;
  /** Full local weekday name, e.g. `"Monday"`. */
  weekday: string;
  /** Signed ISO offset at this instant, e.g. `"+05:30"`. */
  utcOffset: string;
}

/**
 * Every reading that needs a zone, with the zone already bound. Obtained from
 * {@link inZone}; there is no other way to get one, and no reading here is
 * reachable without one.
 *
 * `at` defaults to now on every reading, because "now" is what the overwhelming
 * majority of call sites mean and threading `new Date()` through them added
 * nothing. Tests and replay pass the instant explicitly.
 */
export interface ZoneClock {
  /** The bound zone, so a `ZoneClock` can be passed where a zone was. */
  readonly timezone: IanaTimezone;

  /**
   * Which calendar day it is here. The day-segment of the briefing idempotency
   * key, so the same machine-day in a user's zone never sends twice.
   *
   * The mint is re-parsed rather than cast: if a future ICU release changed what
   * `sv-SE` emits, this throws instead of poisoning every day key in the system.
   */
  day(at?: Date): LocalDateKey;

  /** 0–23 hour-of-day here. */
  hour(at?: Date): number;

  /**
   * Signed offset from UTC, in milliseconds. The only place the `longOffset`
   * string is parsed — {@link LocalWallClock.utcOffset} and the day-boundary
   * converge loop both derive from this one reader.
   */
  offsetMs(at?: Date): number;

  /** The whole wall clock here, in one `Intl` pass. */
  clock(at?: Date): LocalWallClock;

  /**
   * The UTC instant at which `hour:00` begins on `day` here — midnight by
   * default. Converges, because the offset depends on the answer (it changes
   * across a DST boundary); three passes is enough for every real zone.
   */
  startOf(day: LocalDateKey, hour?: number): Date;

  /**
   * `[start, end)` for the calendar day containing `at`. Each bound converges on
   * *its own* offset, so a DST transition day correctly yields a 23h or 25h
   * window — where deriving "tomorrow" as `now + 86_400_000` collapsed a
   * fall-back morning to a **one-hour** window.
   */
  dayBounds(at?: Date): { start: Date; end: Date };

  /**
   * Render an instant as it reads here: `"Mon, Jun 11, 3:04 PM"`. One style, so
   * it takes no style argument; a second one arrives as a closed enum the way
   * {@link LocalDayStyle} did.
   */
  format(at: Date): string;
}

// Declared before `inZone` so a module-scope caller can't hit the temporal dead
// zone. Bounded in practice by the valid IANA zones (~600), same argument as the
// formatter cache above.
const clockCache = new Map<IanaTimezone, ZoneClock>();

/**
 * Bind a zone and get every reading that needs one.
 *
 * Memoized per zone: the returned clock holds no expiring resource and no
 * lifetime rule — it is a pure binding over the module-scope formatter cache —
 * so `inZone(tz).day()` inline at a call site is as cheap as holding one. That
 * is deliberately unlike a memo around a *credential*, which would convert a
 * cache into a lifetime rule for the caller; there is nothing here to expire.
 */
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
      // `hour: 'numeric'` with `hour12: false` returns "0".."23"; some engines
      // emit "24" at midnight. Normalize.
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

/** A signed offset in milliseconds as an ISO fragment (`"+05:30"`, `"-04:00"`). */
function isoOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const totalMinutes = Math.abs(offsetMs) / 60_000;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
