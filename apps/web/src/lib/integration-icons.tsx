import { Check, Globe2, Slack, Users, type LucideIcon } from "lucide-react";
import {
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siGoogleslides,
  siLinear,
  type SimpleIcon,
} from "simple-icons";
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
      kind: "simple";
      icon: SimpleIcon;
      frostColor?: string;
    }
  | {
      kind: "lucide";
      icon: LucideIcon;
      color: string;
    };

const BRAND_ICONS: Record<IntegrationBrand, BrandIconMeta> = {
  collaborators: { kind: "lucide", icon: Users, color: "#e5e7eb" },
  github: { kind: "simple", icon: siGithub, frostColor: "#f4f4f5" },
  gmail: { kind: "simple", icon: siGmail },
  google_calendar: { kind: "simple", icon: siGooglecalendar },
  google_drive: { kind: "simple", icon: siGoogledrive },
  google_docs: { kind: "simple", icon: siGoogledocs },
  google_sheets: { kind: "simple", icon: siGooglesheets },
  google_slides: { kind: "simple", icon: siGoogleslides },
  linear: { kind: "simple", icon: siLinear },
  slack: { kind: "lucide", icon: Slack, color: "#4A154B" },
  web: { kind: "lucide", icon: Globe2, color: "#38bdf8" },
};

const TILE_SIZE_CLASS = {
  sm: "size-7 rounded-lg",
  md: "size-10 rounded-xl",
  xs: "size-6 rounded-full",
} as const;

const GLYPH_SIZE = {
  sm: 15,
  md: 19,
  xs: 12,
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
  size = 16,
  variant = "plain",
  className,
}: {
  brand: IntegrationBrand;
  size?: number;
  variant?: "plain" | "frost";
  className?: string;
}) {
  const meta = BRAND_ICONS[brand];

  if (meta.kind === "lucide") {
    const Icon = meta.icon;
    return <Icon size={size} className={cn("shrink-0", className)} style={{ color: meta.color }} />;
  }

  const color = variant === "frost" && meta.frostColor ? meta.frostColor : `#${meta.icon.hex}`;

  return (
    <svg
      aria-hidden
      className={cn("shrink-0", className)}
      fill="currentColor"
      height={size}
      style={{ color }}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={meta.icon.path} />
    </svg>
  );
}
