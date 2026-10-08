import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";

export function HeroTile({
  brand,
  variant,
  rotate = 0,
}: {
  brand: IntegrationBrand;
  variant: "center" | "side";
  rotate?: number | undefined;
}) {
  const isCenter = variant === "center";

  // The tile is the artwork; the wrapper adds rotation and shadow.
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
