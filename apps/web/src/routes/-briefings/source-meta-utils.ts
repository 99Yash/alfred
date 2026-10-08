import type { IntegrationSlug } from "@alfred/contracts";

/**
 * Parse `provider · [repo ·] kind`. The provider shows as a glyph, so drop it
 * and strip its prefix from the kind (`github.pr_review` → `pr review`).
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

/** Colors for monochrome brand marks only; other marks carry their own. */
export const PROVIDER_COLOR = new Map<IntegrationSlug, string>([["github", "#181925"]]); // drift-ok: absence means the brand mark carries its own color; only monochrome marks need one

/** `<startISO> - <endISO>` as a local time range, or the original string if it does not parse. */
export function formatEventRange(subtitle: string, timeZone: string): string {
  const parts = subtitle.split(" - ");

  if (parts.length !== 2) return subtitle;
  // SAFETY: the length check proves two parts.
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

  const sameDay = day(startDate) === day(endDate);

  return sameDay
    ? `${time(startDate)} – ${time(endDate)}`
    : `${day(startDate)}, ${time(startDate)} – ${day(endDate)}, ${time(endDate)}`;
}
