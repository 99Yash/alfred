// Date text for the web, in the browser's zone. Each option selects one rule, so every
// surface keeps its own wording while the rules live in one place.

const MINUTE = 60 * 1000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

/** Unparseable input: "input" returns it raw, "empty" returns "". */
type InvalidText = "input" | "empty";

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Oct 21, 3:04 PM" in the browser's zone. With no options the locale is the browser's and an
 * unparseable input comes back unchanged.
 */
export function formatDateTime(
  iso: string,
  format: {
    /** Same-day text: "3:04 PM", "today at 3:04 PM", or "Today, 3:04 PM". Omitted: the date, like any other day. */
    today?: "clock" | "sentence" | "label";
    /** "Yesterday 3:04 PM" for the day before today. */
    yesterday?: boolean;
    /** "other-years" adds the year to a date outside the current year. */
    year?: "never" | "other-years";
    /** Omitted: the browser's locale. */
    locale?: "en-US";
    invalid?: InvalidText;
  } = {},
): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return format.invalid === "empty" ? "" : iso;

  const now = new Date();

  const clock = () =>
    date.toLocaleTimeString(format.locale, { hour: "numeric", minute: "2-digit" });

  if (format.today && sameDay(date, now)) {
    if (format.today === "sentence") return `today at ${clock()}`;

    if (format.today === "label") return `Today, ${clock()}`;

    return clock();
  }

  if (format.yesterday) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    if (sameDay(date, yesterday)) return `Yesterday ${clock()}`;
  }

  const otherYear = format.year === "other-years" && date.getFullYear() !== now.getFullYear();

  return date.toLocaleString(format.locale, {
    ...(otherYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * "ago": "5m ago", "3h ago", "2d ago", with no cutover to a date.
 * "compact": "now", "5m", "3h", "6d", then "Oct 21".
 * With no options the style is "ago" and an unparseable input comes back unchanged.
 */
export function formatRelative(
  iso: string,
  format: { style?: "ago" | "compact"; invalid?: InvalidText } = {},
): string {
  const t = Date.parse(iso);

  if (Number.isNaN(t)) return format.invalid === "empty" ? "" : iso;
  const delta = Date.now() - t;

  if (format.style === "compact") {
    if (delta < MINUTE) return "now";

    if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;

    if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
    const days = Math.floor(delta / DAY);

    if (days < 7) return `${days}d`;

    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const mins = Math.floor(delta / MINUTE);

  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);

  if (hrs < 24) return `${hrs}h ago`;

  return `${Math.floor(hrs / 24)}d ago`;
}
