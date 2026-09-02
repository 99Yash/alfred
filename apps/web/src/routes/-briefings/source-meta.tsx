import { isIntegrationSlug, type GatherSourceSlug } from "@alfred/contracts";
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CloudSun,
  Mail,
  type LucideIcon,
} from "lucide-react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { PROVIDER_COLOR } from "./source-meta-utils";

/**
 * Display metadata for a briefing's gather sources (ADR-0049). The source slug
 * is carried on every section and source panel, so the timeline can show a
 * leading icon per source without inferring anything from prose. Sources backed
 * by a single vendor render that vendor's brand mark; the rest fall back to a
 * toned lucide glyph.
 */
const SOURCE_BRAND = new Map<GatherSourceSlug, IntegrationBrand>([
  ["email", "gmail"],
  ["calendar", "google_calendar"],
]);

const SOURCE_LUCIDE = {
  email: Mail,
  calendar: CalendarDays,
  integration_activity: Activity,
  weather: CloudSun,
  day_of_week: CalendarClock,
} satisfies Record<GatherSourceSlug, LucideIcon>;

/** Vendor brand mark where the source maps to one, else a toned lucide glyph. */
export function SourceIcon({ source }: { source: GatherSourceSlug }) {
  const brand = SOURCE_BRAND.get(source);
  if (brand) return <IntegrationGlyph brand={brand} size={13} />;
  const Icon = SOURCE_LUCIDE[source] ?? Activity;
  return <Icon size={12} aria-hidden />;
}

/**
 * Inline brand mark for an integration-activity provider. Falls back to a
 * generic Activity icon when the provider is not a known slug or has no
 * catalog brand (system, imessage).
 */
export function ProviderGlyph({ provider, size = 14 }: { provider: string; size?: number }) {
  if (!isIntegrationSlug(provider)) {
    return <Activity size={size} aria-hidden className="text-app-fg-2" />;
  }
  const brand = brandForIntegration(provider);
  if (!brand) return <Activity size={size} aria-hidden className="text-app-fg-2" />;
  return (
    <IntegrationGlyph brand={brand} size={size} colorOverride={PROVIDER_COLOR.get(provider)} />
  );
}
