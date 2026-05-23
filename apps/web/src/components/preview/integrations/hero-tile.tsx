import { IntegrationGlyph } from "~/lib/integration-icons";
import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";

export function HeroTile({
  brand,
  variant,
  rotate = 0,
  isMono,
}: {
  brand: IntegrationProvider["brand"];
  variant: "center" | "side";
  rotate?: number;
  isMono: boolean;
}) {
  const isCenter = variant === "center";
  return (
    <div
      className={cn(
        "grid place-items-center bg-vs-bg-1 transition-transform",
        isCenter ? "size-[120px] rounded-[26px]" : "size-[88px] rounded-[22px] opacity-90",
        "shadow-[var(--vs-shadow-elevated)]",
        isMono && "text-vs-fg-4",
      )}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <IntegrationGlyph
        brand={brand}
        size={isCenter ? 52 : 38}
        colorOverride={isMono ? "var(--vs-fg-4)" : undefined}
      />
    </div>
  );
}
