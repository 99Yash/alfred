import type { CSSProperties } from "react";
import { BRAND_ACCENT, IntegrationIcon } from "~/lib/integrations/integration-icons";
import type { IntegrationProvider } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/**
 * Satellite tiles scattered behind the center mark. Mirrors dimension's
 * integration background-vector banners: the provider's own coin repeated at
 * varied depths — large faint tiles cropped off the corners read as "far",
 * smaller crisper ones sit "near" — so the flat backdrop gains parallax.
 * Positioned in percentages so the scatter survives the responsive width.
 * `blur` softens the largest, lowest-opacity tiles so they recede rather than
 * compete with the sharp center mark.
 */
const SATELLITES: ReadonlyArray<{
  id: string;
  size: number;
  rotate: number;
  opacity: number;
  blur?: boolean;
  style: CSSProperties;
}> = [
  // Large faint tile bleeding off the top-right corner — the deepest layer.
  {
    id: "far-tr",
    size: 132,
    rotate: 8,
    opacity: 0.12,
    blur: true,
    style: { top: -44, right: -36 },
  },
  // Mid tile cropped at the bottom-left.
  {
    id: "far-bl",
    size: 92,
    rotate: -6,
    opacity: 0.2,
    blur: true,
    style: { bottom: -28, left: -22 },
  },
  // Crisp small satellites floating near the center band.
  { id: "near-tl", size: 52, rotate: -9, opacity: 0.6, style: { top: 18, left: "16%" } },
  { id: "near-br", size: 40, rotate: 7, opacity: 0.7, style: { bottom: 26, right: "20%" } },
  { id: "near-tr", size: 34, rotate: -4, opacity: 0.55, style: { top: "30%", right: "13%" } },
];

export function HeroPreview({ provider }: { provider: IntegrationProvider }) {
  // Colored brands light their hero in their own hue; monochrome marks fall
  // back to the house purple. Low-alpha mix keeps it ambient in both themes.
  const accent = BRAND_ACCENT[provider.brand];
  const glow = accent ? `color-mix(in srgb, ${accent} 24%, transparent)` : "var(--app-purple-2)";
  return (
    <div
      aria-hidden
      className={cn(
        "relative h-[200px] w-full overflow-hidden rounded-3xl app-card-in",
        "bg-app-bg-2",
      )}
      style={{ animationDelay: "60ms" }}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-50 dark:opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--app-bg-a2) 1px, transparent 1px), linear-gradient(to bottom, var(--app-bg-a2) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(60% 60% at 50% 50%, black 0%, rgba(0,0,0,0.5) 60%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `radial-gradient(120% 90% at 50% 110%, ${glow} 0%, transparent 55%)`,
        }}
      />
      {/* Scattered satellite marks — the parallax constellation behind the hero.
       * The wrapper carries the px size (so arbitrary sizes survive JIT), and
       * `size-full` on the icon overrides its default size class via twMerge.
       * The coin bakes in its own elevated shadow, so we don't re-add one. */}
      {SATELLITES.map((sat) => (
        <div
          key={sat.id}
          className={cn("absolute", sat.blur && "blur-[1px]")}
          style={{
            ...sat.style,
            width: sat.size,
            height: sat.size,
            opacity: sat.opacity,
            transform: `rotate(${sat.rotate}deg)`,
          }}
        >
          <IntegrationIcon brand={provider.brand} className="size-full rounded-full" />
        </div>
      ))}
      {/* Sharp center mark, lifted above the constellation. */}
      <div className="relative flex h-full items-center justify-center">
        <IntegrationIcon brand={provider.brand} className="size-[116px] rounded-full" />
      </div>
    </div>
  );
}
