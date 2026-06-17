import { IntegrationIcon } from "~/lib/integration-icons";
import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";

export function HeroTile({
  brand,
  variant,
  rotate = 0,
}: {
  brand: IntegrationProvider["brand"];
  variant: "center" | "side";
  rotate?: number;
}) {
  const isCenter = variant === "center";
  // The full-bleed tile is the artwork itself; the wrapper only carries the
  // rotation and the elevated drop shadow that floats it off the backdrop.
  return (
    <div className="transition-transform" style={{ transform: `rotate(${rotate}deg)` }}>
      <IntegrationIcon
        brand={brand}
        className={cn(
          "shadow-[var(--app-shadow-elevated)]",
          isCenter ? "size-[120px] rounded-full" : "size-[88px] rounded-full opacity-90",
        )}
      />
    </div>
  );
}
