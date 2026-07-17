import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";

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
  // The full-bleed tile is the artwork itself; the wrapper only carries the
  // rotation and the elevated drop shadow that floats it off the backdrop.
  return (
    <div className="app-stack transition-transform" style={{ transform: `rotate(${rotate}deg)` }}>
      <IntegrationIcon
        brand={brand}
        className={cn(
          "shadow-[var(--app-shadow-elevated)]",
          isCenter ? "size-[112px] rounded-full" : "size-[84px] rounded-full opacity-90",
        )}
      />
    </div>
  );
}
