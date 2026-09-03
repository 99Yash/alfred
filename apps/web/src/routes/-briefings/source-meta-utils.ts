import type { IntegrationSlug } from "@alfred/contracts";

/**
 * Activity panel subtitles arrive as `provider · [repo ·] kind` from the
 * server's deterministic projection. We render the provider as a brand glyph
 * instead of a word, so the leading token is dropped and the redundant
 * `<provider>.` prefix is stripped off the kind (e.g. `github.pr_review` →
 * `pr review`). Returns the provider slug plus the human remainder.
 */
interface ParsedActivitySubtitle {
  provider: string;
  detail: string;
}

export function parseActivitySubtitle(subtitle: string): ParsedActivitySubtitle {
  const [provider = "", ...rest] = subtitle.split(" · ");
  const detail = rest
    .map((part) => (part.startsWith(`${provider}.`) ? part.slice(provider.length + 1) : part))
    .join(" · ");
  return { provider, detail };
}

/**
 * Monochrome brand marks need a visible color on the white panel. Sparse on
 * purpose: a slug absent here has a brand mark that carries its own color.
 */
export const PROVIDER_COLOR = new Map<IntegrationSlug, string>([["github", "#181925"]]); // drift-ok: absence means the brand mark carries its own color; only monochrome marks need one

/**
 * Format a calendar panel subtitle (`<startISO> - <endISO>`) into a human time
 * range in the briefing's timezone — e.g. "10:00 AM – 10:30 AM". Falls back to
 * the original string when it isn't a parseable ISO range (older rows, all-day
 * events, etc.).
 */
export function formatEventRange(subtitle: string, timeZone: string): string {
  const parts = subtitle.split(" - ");
  if (parts.length !== 2) return subtitle;
  // SAFETY: the length check above proves the split yielded exactly two parts.
  const [start, end] = parts as [string, string];
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return subtitle;

  const time = (d: Date) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone || undefined,
    }).format(d);
  const day = (d: Date) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: timeZone || undefined,
    }).format(d);

  // Same calendar day → time range only; otherwise prefix the start's date.
  const sameDay = day(startDate) === day(endDate);
  return sameDay
    ? `${time(startDate)} – ${time(endDate)}`
    : `${day(startDate)}, ${time(startDate)} – ${day(endDate)}, ${time(endDate)}`;
}
