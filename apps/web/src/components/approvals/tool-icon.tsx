import type { IntegrationSlug } from "@alfred/contracts";
import { MessageSquare, Settings2, type LucideIcon } from "lucide-react";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

/**
 * Maps an integration slug to its real brand mark. Slugs without a brand
 * (internal `system` tools, `imessage`) fall back to a neutral glyph tile so
 * every staged tool still renders an icon.
 */
const SLUG_TO_BRAND: Partial<Record<IntegrationSlug, IntegrationBrand>> = {
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

/** Brand mark for an integration slug, or `undefined` for brandless slugs. */
export function brandForIntegration(integration: IntegrationSlug): IntegrationBrand | undefined {
  return SLUG_TO_BRAND[integration];
}

const GLYPH_FALLBACK: Partial<Record<IntegrationSlug, LucideIcon>> = {
  system: Settings2,
  imessage: MessageSquare,
};

export function ToolIcon({ integration }: { integration: IntegrationSlug }) {
  const brand = SLUG_TO_BRAND[integration];
  if (brand) {
    return <IntegrationIcon brand={brand} size="md" title={integration} />;
  }

  // No brand artwork — render the Lucide mark on a theme-aware neutral coin so
  // it sits in the same family as the full-bleed app-icon coins beside it.
  const Glyph = GLYPH_FALLBACK[integration] ?? Settings2;
  return (
    <span
      aria-hidden
      title={integration}
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-full",
        "bg-app-bg-2 text-app-fg-3 shadow-[var(--app-shadow-elevated)]",
      )}
    >
      <Glyph size={18} />
    </span>
  );
}
