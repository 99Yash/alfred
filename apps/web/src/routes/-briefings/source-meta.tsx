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

/** Brand mark per single-vendor gather source (ADR-0049); others get a toned glyph. */
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

export function SourceIcon({ source }: { source: GatherSourceSlug }) {
  const brand = SOURCE_BRAND.get(source);

  if (brand) return <IntegrationGlyph brand={brand} size={13} />;
  const Icon = SOURCE_LUCIDE[source] ?? Activity;

  return <Icon size={12} aria-hidden />;
}

/** Brand mark for an activity provider, or a generic Activity icon. */
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
