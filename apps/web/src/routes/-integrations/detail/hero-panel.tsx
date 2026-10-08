import type { CSSProperties } from "react";
import { brandAccent, IntegrationIcon } from "~/lib/integrations/integration-icons";
import type { IntegrationPage } from "~/lib/integrations/integrations";
import { cn } from "~/lib/utils";

/**
 * The provider's coin repeated behind the center mark at varied size, opacity,
 * and blur, for parallax depth. Percent positions survive responsive widths.
 */
const SATELLITES: ReadonlyArray<{
  id: string;
  size: number;
  rotate: number;
  opacity: number;
  blur?: boolean | undefined;
  style: CSSProperties;
}> = [
  // Deepest layer, off the top-right corner.
  {
    id: "far-tr",
    size: 132,
    rotate: 8,
    opacity: 0.12,
    blur: true,
    style: { top: -44, right: -36 },
  },
  {
    id: "far-bl",
    size: 92,
    rotate: -6,
    opacity: 0.2,
    blur: true,
    style: { bottom: -28, left: -22 },
  },
  { id: "near-tl", size: 52, rotate: -9, opacity: 0.6, style: { top: 18, left: "16%" } },
  { id: "near-br", size: 40, rotate: 7, opacity: 0.7, style: { bottom: 26, right: "20%" } },
  { id: "near-tr", size: 34, rotate: -4, opacity: 0.55, style: { top: "30%", right: "13%" } },
];

export function HeroPanel({ provider }: { provider: IntegrationPage }) {
  // Brand hue, or house purple for monochrome marks.
  const accent = brandAccent(provider.brand);
  const glow = accent ? `color-mix(in srgb, ${accent} 24%, transparent)` : "var(--app-purple-2)";

  return (
    <div
      aria-hidden
      className={cn(
        "app-card-in relative h-[200px] w-full overflow-hidden rounded-3xl",
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
      {/* The wrapper carries the px size; `size-full` overrides the icon's own size via twMerge.
       * The coin has its own shadow. */}
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
      {/* Center mark */}
      <div className="relative flex h-full items-center justify-center">
        <IntegrationIcon brand={provider.brand} className="size-[116px] rounded-full" />
      </div>
    </div>
  );
}
