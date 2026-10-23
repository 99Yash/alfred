import { isCatalogSlug, type CatalogSlug, type IntegrationSlug } from "@alfred/contracts";
import { MessageSquare, Settings2, type LucideIcon } from "lucide-react";
import { IntegrationIcon, type IntegrationIconSize } from "~/lib/integrations/integration-icons";
import { brandForIntegration } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/** Glyphs for slugs with no catalog brand. Exhaustive, so a new internal slug fails to compile until it has one. */
const GLYPH_FALLBACK = {
  system: Settings2,
  mcp: Settings2,
  imessage: MessageSquare,
} satisfies Record<Exclude<IntegrationSlug, CatalogSlug>, LucideIcon>;

/** The neutral coin at each `IntegrationIcon` size, so a brandless slug matches a branded one. */
const COIN_SIZE = {
  xs: { className: "size-6", glyph: 13 },
  sm: { className: "size-7", glyph: 14 },
  md: { className: "size-10", glyph: 18 },
} as const satisfies Record<IntegrationIconSize, { className: string; glyph: number }>;

export function ToolIcon({
  integration,
  size = "md",
}: {
  integration: IntegrationSlug;
  size?: IntegrationIconSize | undefined;
}) {
  const brand = brandForIntegration(integration);

  if (brand) {
    return <IntegrationIcon brand={brand} size={size} title={integration} />;
  }

  // A neutral coin. The catalog map forbids a brandless catalog slug, so `Settings2` is a fallback only.
  const Glyph = isCatalogSlug(integration) ? Settings2 : GLYPH_FALLBACK[integration];
  const coin = COIN_SIZE[size];

  return (
    <span
      aria-hidden
      title={integration}
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        coin.className,
        "bg-app-bg-2 text-app-fg-3 shadow-(--app-shadow-elevated)",
      )}
    >
      <Glyph size={coin.glyph} />
    </span>
  );
}
