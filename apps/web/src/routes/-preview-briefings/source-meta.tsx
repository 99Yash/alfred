import type { GatherSourceSlug } from "@alfred/contracts";
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CloudSun,
  Mail,
  type LucideIcon,
} from "lucide-react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { PROVIDER_BRAND, PROVIDER_COLOR } from "./source-meta-utils";

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
 * Inline brand mark for an integration-activity provider. Falls back to a
 * generic Activity icon for providers without a brand glyph (system, imessage).
 */
export function ProviderGlyph({ provider, size = 14 }: { provider: string; size?: number }) {
  const brand = PROVIDER_BRAND[provider as keyof typeof PROVIDER_BRAND];
  if (!brand) return <Activity size={size} aria-hidden className="text-app-fg-2" />;
  return (
    <IntegrationGlyph
      brand={brand}
      size={size}
      colorOverride={PROVIDER_COLOR[provider as keyof typeof PROVIDER_COLOR]}
    />
  );
}
