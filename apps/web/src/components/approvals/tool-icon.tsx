import { isCatalogSlug, type CatalogSlug, type IntegrationSlug } from "@alfred/contracts";
import { MessageSquare, Settings2, type LucideIcon } from "lucide-react";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/**
 * Slugs without a catalog brand (Alfred's own `system` and `mcp` tools,
 * `imessage`) fall back to a neutral glyph tile so every staged tool still
 * renders an icon. Exhaustive over the non-catalog slugs: a new internal or
 * channel entry in the registry is a compile error here until it has a glyph.
 */
const GLYPH_FALLBACK = {
  system: Settings2,
  mcp: Settings2,
  imessage: MessageSquare,
} satisfies Record<Exclude<IntegrationSlug, CatalogSlug>, LucideIcon>;

export function ToolIcon({ integration }: { integration: IntegrationSlug }) {
  const brand = brandForIntegration(integration);
  if (brand) {
    return <IntegrationIcon brand={brand} size="md" title={integration} />;
  }

  // No brand artwork — render the Lucide mark on a theme-aware neutral coin so
  // it sits in the same family as the full-bleed app-icon coins beside it. A
  // catalog slug only lands here when its page has no brand, which the catalog
  // map forbids; the neutral glyph is the same fallback the Map used to return.
  const Glyph = isCatalogSlug(integration) ? Settings2 : GLYPH_FALLBACK[integration];
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
