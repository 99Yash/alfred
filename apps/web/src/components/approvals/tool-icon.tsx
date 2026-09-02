import type { IntegrationSlug } from "@alfred/contracts";
import { MessageSquare, Settings2, type LucideIcon } from "lucide-react";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/**
 * Slugs without a catalog brand (internal `system` tools, `imessage`) fall
 * back to a neutral glyph tile so every staged tool still renders an icon.
 */
const GLYPH_FALLBACK = new Map<IntegrationSlug, LucideIcon>([
  ["system", Settings2],
  ["imessage", MessageSquare],
]);

export function ToolIcon({ integration }: { integration: IntegrationSlug }) {
  const brand = brandForIntegration(integration);
  if (brand) {
    return <IntegrationIcon brand={brand} size="md" title={integration} />;
  }

  // No brand artwork — render the Lucide mark on a theme-aware neutral coin so
  // it sits in the same family as the full-bleed app-icon coins beside it.
  const Glyph = GLYPH_FALLBACK.get(integration) ?? Settings2;
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
