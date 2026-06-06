import type { GatherSourceSlug, IntegrationSlug } from "@alfred/contracts";
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CloudSun,
  Mail,
  type LucideIcon,
} from "lucide-react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";

/**
 * Display metadata for a briefing's gather sources (ADR-0049). The source slug
 * is carried on every section and source panel, so the timeline can show a
 * leading icon per source without inferring anything from prose. Sources backed
 * by a single vendor render that vendor's brand mark; the rest fall back to a
 * toned lucide glyph.
 */
const SOURCE_BRAND: Partial<Record<GatherSourceSlug, IntegrationBrand>> = {
  email: "gmail",
  calendar: "google_calendar",
};

const SOURCE_LUCIDE: Record<GatherSourceSlug, LucideIcon> = {
  email: Mail,
  calendar: CalendarDays,
  integration_activity: Activity,
  weather: CloudSun,
  day_of_week: CalendarClock,
};

/** Vendor brand mark where the source maps to one, else a toned lucide glyph. */
export function SourceIcon({ source }: { source: GatherSourceSlug }) {
  const brand = SOURCE_BRAND[source];
  if (brand) return <IntegrationGlyph brand={brand} size={13} />;
  const Icon = SOURCE_LUCIDE[source] ?? Activity;
  return <Icon size={12} aria-hidden />;
}

/**
 * Activity panel subtitles arrive as `provider · [repo ·] kind` from the
 * server's deterministic projection. We render the provider as a brand glyph
 * instead of a word, so the leading token is dropped and the redundant
 * `<provider>.` prefix is stripped off the kind (e.g. `github.pr_review` →
 * `pr review`). Returns the provider slug plus the human remainder.
 */
export function parseActivitySubtitle(subtitle: string): { provider: string; detail: string } {
  const [provider = "", ...rest] = subtitle.split(" · ");
  const detail = rest
    .map((part) => (part.startsWith(`${provider}.`) ? part.slice(provider.length + 1) : part))
    .join(" · ");
  return { provider, detail };
}

/** Map a connected-integration slug to a brand glyph, where one exists. */
const PROVIDER_BRAND: Partial<Record<IntegrationSlug, IntegrationBrand>> = {
  gmail: "gmail",
  calendar: "google_calendar",
  drive: "google_drive",
  docs: "google_docs",
  sheets: "google_sheets",
  slides: "google_slides",
  slack: "slack",
  linear: "linear",
  github: "github",
};

/** Monochrome brand marks need a visible color on the white panel. */
const PROVIDER_COLOR: Partial<Record<IntegrationSlug, string>> = {
  github: "#181925",
};

/**
 * Inline brand mark for an integration-activity provider. Falls back to a
 * generic Activity icon for providers without a brand glyph (system, imessage).
 */
export function ProviderGlyph({ provider, size = 14 }: { provider: string; size?: number }) {
  const brand = PROVIDER_BRAND[provider as IntegrationSlug];
  if (!brand) return <Activity size={size} aria-hidden className="text-app-fg-2" />;
  return (
    <IntegrationGlyph
      brand={brand}
      size={size}
      colorOverride={PROVIDER_COLOR[provider as IntegrationSlug]}
    />
  );
}

/**
 * Format a calendar panel subtitle (`<startISO> - <endISO>`) into a human time
 * range in the briefing's timezone — e.g. "10:00 AM – 10:30 AM". Falls back to
 * the original string when it isn't a parseable ISO range (older rows, all-day
 * events, etc.).
 */
export function formatEventRange(subtitle: string, timeZone: string): string {
  const parts = subtitle.split(" - ");
  if (parts.length !== 2) return subtitle;
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
