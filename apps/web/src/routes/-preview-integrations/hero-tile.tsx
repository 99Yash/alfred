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
        "grid place-items-center bg-app-bg-1 app-stack transition-transform",
        isCenter ? "size-[112px] rounded-[26px]" : "size-[84px] rounded-[20px] opacity-90",
        "shadow-[var(--app-shadow-elevated)]",
        isMono && "text-app-fg-4",
      )}
      style={{
        transform: `rotate(${rotate}deg)`,
      }}
    >
      <IntegrationGlyph
        brand={brand}
        size={isCenter ? 48 : 36}
        colorOverride={isMono ? "var(--app-fg-4)" : undefined}
      />
    </div>
  );
}
