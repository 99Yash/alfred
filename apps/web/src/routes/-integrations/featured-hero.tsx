import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { HeroTile } from "./hero-tile";

export function FeaturedHero({ brands }: { brands: ReadonlyArray<IntegrationBrand> }) {
  // Pick 3 brands; if fewer than 3 connected, pad missing slots with the first.
  const picks: [IntegrationBrand, IntegrationBrand, IntegrationBrand] = (() => {
    if (brands.length === 0) return ["gmail", "google_calendar", "google_drive"];
    const [a = brands[0]!, b = brands[0]!, c = brands[0]!] = brands;
    return [a, b, c];
  })();

  return (
    <div
      aria-hidden
      className={cn(
        "app-card-in relative mt-8 h-[180px] w-full overflow-hidden rounded-3xl",
        "bg-app-bg-2",
      )}
      style={{ animationDelay: "60ms" }}
    >
      {/* Grid backdrop with radial mask — subtle texture */}
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
      {/* Radial accent at center-bottom */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 110%, var(--app-purple-2) 0%, transparent 55%)",
        }}
      />
      <div className="group relative flex h-full items-center justify-center gap-6">
        <HeroTile brand={picks[0]!} variant="side" rotate={-4} />
        <HeroTile brand={picks[1]!} variant="center" />
        <HeroTile brand={picks[2]!} variant="side" rotate={4} />
      </div>
    </div>
  );
}
