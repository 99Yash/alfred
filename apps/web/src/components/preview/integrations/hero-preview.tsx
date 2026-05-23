import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { HeroTile } from "./hero-tile";

const MONOCHROME_BRANDS = new Set<IntegrationProvider["brand"]>(["github"]);

export function HeroPreview({ provider }: { provider: IntegrationProvider }) {
  const isMono = MONOCHROME_BRANDS.has(provider.brand);

  return (
    <div
      aria-hidden
      className={cn(
        "relative h-[200px] w-full overflow-hidden rounded-3xl vs-card-in",
        "bg-vs-bg-2",
      )}
      style={{ animationDelay: "60ms" }}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-50 dark:opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--vs-bg-a2) 1px, transparent 1px), linear-gradient(to bottom, var(--vs-bg-a2) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(60% 60% at 50% 50%, black 0%, rgba(0,0,0,0.5) 60%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 110%, var(--vs-purple-2) 0%, transparent 55%)",
        }}
      />
      <div className="relative flex h-full items-center justify-center gap-6">
        <HeroTile brand={provider.brand} variant="side" rotate={-4} isMono={isMono} />
        <HeroTile brand={provider.brand} variant="center" isMono={isMono} />
        <HeroTile brand={provider.brand} variant="side" rotate={4} isMono={isMono} />
      </div>
    </div>
  );
}
