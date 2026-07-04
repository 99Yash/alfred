export function localStartOfDay(localDate: string, timezone: string): Date {
  return localTimeInTimezone(localDate, 0, timezone);
}

export function localTimeInTimezone(localDate: string, hour: number, timezone: string): Date {
  let candidate = new Date(Date.UTC(...dateParts(localDate), hour));
  for (let i = 0; i < 3; i += 1) {
    candidate = new Date(
      Date.UTC(...dateParts(localDate), hour) - timezoneOffsetMs(candidate, timezone),
    );
  }
  return candidate;
}

export function addLocalDays(localDate: string, days: number): string {
  const next = new Date(Date.UTC(...dateParts(localDate), 12));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * Render an instant as a human-readable wall-clock string in the user's
 * timezone — e.g. "Fri, Jun 26, 3:10 AM". Used to hand the briefing agent a
 * local receipt time it can phrase naturally ("a late-night request came in
 * around 3am") instead of raw UTC (#284). Returns null for a null instant so
 * callers can pass it straight through from a nullable `authoredAt`.
 */
export function formatInstantInTimezone(instant: Date | null, timezone: string): string | null {
  if (!instant) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

function timezoneOffsetMs(at: Date, timezone: string): number {
  const value =
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/.exec(value);
  if (!match?.groups?.sign) return 0;

  const sign = match.groups.sign === "-" ? -1 : 1;
  const hours = Number(match.groups.hours);
  const minutes = Number(match.groups.minutes ?? "0");
  return sign * (hours * 60 + minutes) * 60_000;
}

function dateParts(localDate: string): [number, number, number] {
  const [year, month, day] = localDate.split("-").map(Number);
  return [year ?? 0, (month ?? 1) - 1, day ?? 1];
}
