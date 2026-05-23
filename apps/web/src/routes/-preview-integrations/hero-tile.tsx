import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { MONOCHROME_BRANDS } from "./helpers";

export function HeroTile({
  brand,
  variant,
  rotate = 0,
}: {
  brand: IntegrationBrand;
  variant: "center" | "side";
  rotate?: number;
}) {
  const isCenter = variant === "center";
  const isMono = MONOCHROME_BRANDS.has(brand);
  return (
    <div
      className={cn(
        "grid place-items-center bg-vs-bg-1 vs-stack transition-transform",
        isCenter ? "size-[112px] rounded-[26px]" : "size-[84px] rounded-[20px] opacity-90",
        "shadow-[var(--vs-shadow-elevated)]",
        isMono && "text-vs-fg-4",
      )}
      style={{
        transform: `rotate(${rotate}deg)`,
      }}
    >
      <IntegrationGlyph
        brand={brand}
        size={isCenter ? 48 : 36}
        colorOverride={isMono ? "var(--vs-fg-4)" : undefined}
      />
    </div>
  );
}
