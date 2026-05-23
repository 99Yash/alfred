import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { MONOCHROME_BRANDS } from "./helpers";

export function ProviderTile({
  brand,
  connected,
}: {
  brand: IntegrationBrand;
  connected: boolean;
}) {
  const isMono = MONOCHROME_BRANDS.has(brand);
  return (
    <span
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-xl bg-vs-bg-2 ring-1 ring-vs-bg-3",
        // For brands whose glyph relies on currentColor (via colorOverride below),
        // text-vs-fg-4 supplies the legible tone in both themes.
        isMono && "text-vs-fg-4",
      )}
    >
      <IntegrationGlyph
        brand={brand}
        size={22}
        colorOverride={isMono ? "var(--vs-fg-4)" : undefined}
      />
      {connected ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-vs-green-4 ring-2 ring-vs-background"
          aria-label="Connected"
        />
      ) : null}
    </span>
  );
}
