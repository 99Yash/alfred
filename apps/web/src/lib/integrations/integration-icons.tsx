import { Check, Globe2, Users, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { BRAND_SVGS, type BrandSvgSlug } from "~/lib/integrations/integration-svgs";
import { INTEGRATION_TILES, type IntegrationTileSlug } from "~/lib/integrations/integration-tiles";
import { cn } from "~/lib/utils";

export type IntegrationBrand =
  | "collaborators"
  | "github"
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "google_docs"
  | "google_sheets"
  | "google_slides"
  | "linear"
  | "slack"
  | "notion"
  | "railway"
  | "vercel"
  | "web";

type BrandIconMeta =
  | {
      kind: "svg";
      slug: BrandSvgSlug;
      // currentColor brand fallback for marks whose dimension source uses a
      // white-on-dark gradient (github, linear). Other multicolor SVGs ignore
      // currentColor entirely.
      plainColor?: string;
      frostColor?: string;
    }
  | {
      kind: "lucide";
      icon: LucideIcon;
      color: string;
    };

const BRAND_ICONS: Record<IntegrationBrand, BrandIconMeta> = {
  collaborators: { kind: "lucide", icon: Users, color: "#e5e7eb" },
  github: {
    kind: "svg",
    slug: "github",
    // Theme-aware on chrome: GitHub's mark is monochrome, so a fixed near-white
    // (#f4f4f5) vanished on light-mode surfaces (tool cards, connect row, mention
    // menu). --app-fg-4 tracks the primary text tone — dark in light mode, light
    // in dark mode. `frost` keeps white for the dark integration tiles.
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  gmail: { kind: "svg", slug: "gmail" },
  google_calendar: { kind: "svg", slug: "google_calendar" },
  google_drive: { kind: "svg", slug: "google_drive" },
  google_docs: { kind: "svg", slug: "google_docs" },
  google_sheets: { kind: "svg", slug: "google_sheets" },
  google_slides: { kind: "svg", slug: "google_slides" },
  linear: {
    kind: "svg",
    slug: "linear",
    plainColor: "#5E6AD2",
    frostColor: "#ffffff",
  },
  slack: { kind: "svg", slug: "slack" },
  // Monochrome marks: like GitHub, the bare glyph is single-tone, so it tracks
  // --app-fg-4 on chrome (dark in light mode, light in dark) and stays white on
  // the dark integration tiles via `frost`. Full-color artwork lives in the
  // app-icon coins (integration-tile-components.tsx).
  notion: {
    kind: "svg",
    slug: "notion",
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  railway: {
    kind: "svg",
    slug: "railway",
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  vercel: {
    kind: "svg",
    slug: "vercel",
    plainColor: "var(--app-fg-4)",
    frostColor: "#f4f4f5",
  },
  web: { kind: "lucide", icon: Globe2, color: "#38bdf8" },
};

/**
 * Per-brand accent color for ambient surfaces — the radial glow behind a
 * provider's detail-page hero (see `HeroPreview`). A brand is keyed here by its
 * primary brand *hue*, not by how its mark renders: Railway's glyph is
 * monochrome on chrome (see `BRAND_ICONS`) yet keeps its magenta glow. Brands
 * absent here (github, notion, vercel) are the ones whose brand color is
 * black/near-gray — a gray glow reads as no glow on the dark canvas — so they
 * fall back to Alfred's house purple (`--app-purple-2`). Values are applied at
 * low alpha via `color-mix`, so the saturation here is intentional — the
 * surface dilutes it.
 */
export const BRAND_ACCENT: Partial<Record<IntegrationBrand, string>> = {
  gmail: "#ea4335",
  google_calendar: "#4285f4",
  google_drive: "#ffb400",
  google_docs: "#4285f4",
  google_sheets: "#1fa463",
  google_slides: "#f9ab00",
  slack: "#a25da3",
  linear: "#5e6ad2",
  railway: "#8c1eaf",
};

const TILE_SIZE_CLASS = {
  sm: "size-7 rounded-full",
  md: "size-10 rounded-full",
  xs: "size-6 rounded-full",
} as const;

const GLYPH_SIZE = {
  sm: 18,
  md: 24,
  xs: 15,
} as const;

// Offsets sit the check on the tile's 4:30 edge. Because the corner of a circle
// recedes from its bounding box, the badge hugs the edge with a smaller outset
// than a square would need (a -1 outset on `md` would float clear of the rim).
const CHECK_SIZE_CLASS = {
  sm: "size-3.5 -bottom-0.5 -right-0.5",
  md: "size-4 -bottom-0.5 -right-0.5",
  xs: "size-3 -bottom-0.5 -right-0.5",
} as const;

/** Brands that ship a full-bleed app-icon tile (background + gloss baked in). */
function hasTile(brand: IntegrationBrand): brand is IntegrationTileSlug {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_TILES, brand);
}

/**
 * An integration's brand mark as a polished, full-bleed app-icon coin — the
 * artwork fills the circle edge-to-edge, lit by the gloss baked into each SVG,
 * and finished with a hairline frost border (no inner glow over the art). The
 * round tile is what makes these read as Alfred's own marks rather than stock
 * app-store tiles; it's used on connect surfaces, the approval tray, onboarding
 * and the integrations catalog. Inline contexts that want just the bare logo
 * next to text use `IntegrationGlyph` instead.
 *
 * Brands without bespoke artwork (`web`, `collaborators`) fall back to their
 * Lucide mark centered on a dark frost coin so every brand still renders a
 * tile rather than a naked glyph.
 */
export function IntegrationIcon({
  brand,
  connected = false,
  size = "sm",
  title,
  className,
}: {
  brand: IntegrationBrand;
  connected?: boolean;
  size?: keyof typeof TILE_SIZE_CLASS;
  /** Retained for source compatibility; tiles carry their own background. */
  variant?: "plain" | "frost";
  title?: string;
  className?: string;
}) {
  const badge = connected ? (
    <span
      className={cn(
        "absolute z-10 grid place-items-center rounded-full bg-emerald-400 text-black",
        // ring tracks the canvas so the check reads as a cut-out in both themes.
        "shadow-[0_1px_4px_rgba(0,0,0,0.28)] ring-2 ring-app-background",
        CHECK_SIZE_CLASS[size],
      )}
      title="Connected"
      aria-label="Connected"
    >
      <Check size={size === "md" ? 11 : 9} strokeWidth={3} />
    </span>
  ) : null;

  if (hasTile(brand)) {
    const Tile = INTEGRATION_TILES[brand];
    return (
      <span
        className={cn("relative block shrink-0", TILE_SIZE_CLASS[size], className)}
        title={title}
      >
        {/* Inner layer clips the full-bleed artwork to the circle. The
         * elevated shadow is a theme-aware hairline + soft drop: a faint dark
         * rim frames the light Google tiles on a light canvas, a faint light
         * rim lifts the dark GitHub/Linear tiles on dark. */}
        <span className="block size-full overflow-hidden rounded-[inherit] shadow-[var(--app-shadow-elevated)]">
          <Tile aria-hidden className="block size-full" />
        </span>
        {badge}
      </span>
    );
  }

  // No bespoke artwork (web, collaborators) — center the Lucide mark on a
  // theme-aware neutral tile so it stays in the same family as the app tiles
  // in both light and dark.
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center bg-app-bg-2 shadow-[var(--app-shadow-elevated)]",
        TILE_SIZE_CLASS[size],
        className,
      )}
      title={title}
    >
      <IntegrationGlyph brand={brand} size={GLYPH_SIZE[size]} />
      {badge}
    </span>
  );
}

export function IntegrationGlyph({
  brand,
  size = 22,
  variant = "plain",
  colorOverride,
  className,
}: {
  brand: IntegrationBrand;
  size?: number;
  variant?: "plain" | "frost";
  /** Override the brand's plain/frost color — needed when the surrounding
   * tile isn't the background tone the brand metadata assumes (e.g. the
   * monochrome GitHub glyph on a white tile). */
  colorOverride?: string;
  className?: string;
}) {
  const meta = BRAND_ICONS[brand];
  // useId is always called regardless of branch so hook order is stable.
  const reactId = useId();
  const uid = `ai_${reactId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  if (meta.kind === "lucide") {
    const Icon = meta.icon;
    return (
      <Icon
        size={size}
        className={cn("shrink-0", className)}
        style={{ color: colorOverride ?? meta.color }}
      />
    );
  }

  const color = colorOverride ?? (variant === "frost" ? meta.frostColor : meta.plainColor);
  // BRAND_SVGS is a hand-curated constant in source (see integration-svgs.ts);
  // there is no user-provided HTML path into this value, so the no-danger rule
  // is a false positive here. We use innerHTML to keep the SVG markup
  // verbatim (filter/clipPath IDs need to live inside the same <svg> element).
  const inner = BRAND_SVGS[meta.slug].replaceAll("__UID0__", uid);

  return (
    <svg
      aria-hidden
      className={cn("shrink-0", className)}
      fill="none"
      height={size}
      style={color ? { color } : undefined}
      viewBox="8 8 34 34"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
