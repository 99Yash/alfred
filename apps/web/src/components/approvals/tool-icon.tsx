import { isCatalogSlug, type CatalogSlug, type IntegrationSlug } from "@alfred/contracts";
import { MessageSquare, Settings2, type LucideIcon } from "lucide-react";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/** Glyphs for slugs with no catalog brand. Exhaustive, so a new internal slug fails to compile until it has one. */
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

  // A neutral coin. The catalog map forbids a brandless catalog slug, so `Settings2` is a fallback only.
  const Glyph = isCatalogSlug(integration) ? Settings2 : GLYPH_FALLBACK[integration];

  return (
    <span
      aria-hidden
      title={integration}
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-full",
        "bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)",
      )}
    >
      <Glyph size={18} />
    </span>
  );
}
