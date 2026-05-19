import { Check, Globe2, Users, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { BRAND_SVGS, type BrandSvgSlug } from "~/lib/integration-svgs";
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
    plainColor: "#181717",
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
  web: { kind: "lucide", icon: Globe2, color: "#38bdf8" },
};

const TILE_SIZE_CLASS = {
  sm: "size-7 rounded-lg",
  md: "size-10 rounded-xl",
  xs: "size-6 rounded-full",
} as const;

const GLYPH_SIZE = {
  sm: 22,
  md: 32,
  xs: 18,
} as const;

const CHECK_SIZE_CLASS = {
  sm: "size-3.5 -bottom-0.5 -right-0.5",
  md: "size-4 -bottom-1 -right-1",
  xs: "size-3 -bottom-0.5 -right-0.5",
} as const;

export function IntegrationIcon({
  brand,
  connected = false,
  size = "sm",
  variant = "plain",
  title,
  className,
}: {
  brand: IntegrationBrand;
  connected?: boolean;
  size?: keyof typeof TILE_SIZE_CLASS;
  variant?: "plain" | "frost";
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center",
        TILE_SIZE_CLASS[size],
        variant === "frost" ? "frost-icon-tile" : "bg-background shadow-soft ring-1 ring-border/60",
        className,
      )}
      title={title}
    >
      <IntegrationGlyph brand={brand} size={GLYPH_SIZE[size]} variant={variant} />
      {connected ? (
        <span
          className={cn(
            "absolute grid place-items-center rounded-full bg-emerald-400 text-black",
            "shadow-[0_1px_4px_rgba(0,0,0,0.28)] ring-2",
            variant === "frost" ? "ring-[#080808]" : "ring-card",
            CHECK_SIZE_CLASS[size],
          )}
          title="Connected"
          aria-label="Connected"
        >
          <Check size={size === "md" ? 11 : 9} strokeWidth={3} />
        </span>
      ) : null}
    </span>
  );
}

export function IntegrationGlyph({
  brand,
  size = 22,
  variant = "plain",
  className,
}: {
  brand: IntegrationBrand;
  size?: number;
  variant?: "plain" | "frost";
  className?: string;
}) {
  const meta = BRAND_ICONS[brand];
  // useId is always called regardless of branch so hook order is stable.
  const reactId = useId();
  const uid = `ai_${reactId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  if (meta.kind === "lucide") {
    const Icon = meta.icon;
    return <Icon size={size} className={cn("shrink-0", className)} style={{ color: meta.color }} />;
  }

  const color = variant === "frost" ? meta.frostColor : meta.plainColor;
  const inner = BRAND_SVGS[meta.slug].replaceAll("__UID0__", uid);

  return (
    <svg
      aria-hidden
      className={cn("shrink-0", className)}
      fill="none"
      height={size}
      style={color ? { color } : undefined}
      viewBox="0 0 50 50"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
