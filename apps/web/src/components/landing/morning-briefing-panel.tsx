import { CalendarDays, MessagesSquare, Sun, Video } from "lucide-react";
import type { ReactNode } from "react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

/**
 * Hero-grade morning briefing panel. Shares the same 5-zone vertical rhythm
 * as InboxMockup and MeetingPrepMockup so the three tabs in HeroShowcase
 * swap without the bezel height jumping:
 *
 *   1. header ribbon (location · temp)
 *   2. primary tile row (integration tiles + unread counts)
 *   3. greeting headline
 *   4. section badge + hairline divider ("Morning Briefing")
 *   5. three content rows (event ledger)
 *
 * Dimension's source-of-truth version is an MP4 clip; ours is static markup
 * with CSS keyframes on the tile badges so the row reads as "live."
 */
export function MorningBriefingPanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative isolate h-full overflow-hidden rounded-[28px] text-left",
        "ring-1 ring-inset ring-white/12",
        "shadow-[0_30px_80px_-30px_rgba(15,30,55,0.55)]",
        "morning-briefing-surface",
        className,
      )}
    >
      {/* 1 — Header ribbon */}
      <div className="relative z-10 flex items-center justify-between gap-3 px-8 pt-7">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-medium uppercase tracking-[0.16em] text-white/60">
          <Sun className="size-3.5 text-white/70" strokeWidth={2.2} />
          Mumbai · 24°
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-2.5 py-1 text-[11.5px] font-medium text-white/90 ring-1 ring-inset ring-white/20 backdrop-blur-sm">
          <span className="relative grid size-2 place-items-center" aria-hidden>
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-300/70" />
            <span className="relative size-1.5 rounded-full bg-emerald-300" />
          </span>
          Synced 6:42 AM
        </span>
      </div>

      {/* 2 — Primary tile row: integrations + unread counts */}
      <IntegrationTileRow />

      {/* 3 — Greeting headline */}
      <div className="relative z-10 px-8 pt-7">
        <h2
          className={cn(
            "max-w-[26ch] text-balance font-semibold leading-[1.08] tracking-[-0.04em] text-white",
            "text-[28px] sm:text-[32px] lg:text-[34px]",
          )}
        >
          Good Morning, Alex. <span className="text-white/95">You have</span>{" "}
          <InlinePictograph>
            <Video className="size-[0.62em]" strokeWidth={2.4} />
          </InlinePictograph>
          <span className="text-white"> 4 meetings</span>{" "}
          <span className="text-white/95">but a free</span>{" "}
          <InlinePictograph>
            <Sun className="size-[0.62em]" strokeWidth={2.4} />
          </InlinePictograph>
          <span className="text-white"> afternoon.</span>
        </h2>
      </div>

      {/* Section badge + hairline divider */}
      <div className="relative z-10 mt-6 px-8">
        <div className="inline-flex items-center gap-2 rounded-full text-[12.5px] font-medium uppercase tracking-[0.18em] text-white/80">
          <span className="grid size-5 place-items-center rounded-md bg-white/15 ring-1 ring-inset ring-white/20 backdrop-blur-sm">
            <Sun className="size-3 text-amber-200" strokeWidth={2.6} />
          </span>
          Morning Briefing
        </div>
        <div className="mt-3 h-px w-full bg-gradient-to-r from-white/35 via-white/10 to-transparent" />
      </div>

      {/* Inline ledger of pill-tagged events */}
      <div className="relative z-10 space-y-3 px-8 pb-8 pt-4 text-[15px] leading-[1.55] text-white/92 sm:text-[16px]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
          <ContentPill icon={<CalendarDays className="size-3.5" />} tone="indigo">
            Product Roadmap Planning
          </ContentPill>
          <span className="text-white/85">until 12:30, then lunch with</span>
          <ContentPill avatar="D" tone="peach">
            Dana
          </ContentPill>
          <span className="text-white/85">.</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
          <ContentPill icon={<CalendarDays className="size-3.5" />} tone="indigo">
            Meridian on-prem call
          </ContentPill>
          <span className="text-white/85">this evening.</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-2.5">
          <ContentPill avatar="M" tone="rose">
            Marcus
          </ContentPill>
          <span className="text-white/85">flagged the checkout bug in</span>
          <ContentPill icon={<MessagesSquare className="size-3.5" />} tone="violet">
            #Eng
          </ContentPill>
          <span className="text-white/85">— 3 customers affected.</span>
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Integration tile row — five frosted-glass tiles with notification badges.
 * Substitute for dimension's `morning-briefing-start.mp4`: the badges have
 * a staggered breathing animation so the row doesn't read as fully static.
 * ------------------------------------------------------------------- */

interface TileSpec {
  brand: IntegrationBrand;
  count: number;
  delayMs: number;
}

const TILES: ReadonlyArray<TileSpec> = [
  { brand: "gmail", count: 12, delayMs: 0 },
  { brand: "google_calendar", count: 4, delayMs: 200 },
  { brand: "slack", count: 11, delayMs: 400 },
  { brand: "linear", count: 7, delayMs: 600 },
  { brand: "github", count: 3, delayMs: 800 },
];

function IntegrationTileRow() {
  return (
    <div className="relative z-10 mx-auto mt-7 flex w-fit items-center justify-center gap-4 rounded-[36px] bg-black/20 px-5 py-4 ring-1 ring-inset ring-white/10 backdrop-blur-sm">
      {TILES.map((tile) => (
        <IntegrationTile key={tile.brand} {...tile} />
      ))}
    </div>
  );
}

function IntegrationTile({ brand, count, delayMs }: TileSpec) {
  return (
    <div className="relative">
      <span
        className={cn(
          "grid size-[72px] shrink-0 place-items-center rounded-2xl",
          "bg-white ring-1 ring-inset ring-white/40",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_8px_24px_-10px_rgba(0,0,0,0.55)]",
        )}
      >
        <IntegrationGlyph
          brand={brand}
          size={48}
          variant="plain"
          colorOverride={brand === "github" ? "#181717" : undefined}
        />
      </span>
      <span
        className={cn(
          "absolute -right-2 -top-2 grid size-7 place-items-center rounded-full",
          "bg-[#ff3a3a] text-[12px] font-semibold text-white tabular",
          "ring-2 ring-[#4867AF] shadow-[0_2px_8px_-2px_rgba(255,58,58,0.55)]",
          "morning-briefing-badge-pulse",
        )}
        style={{ animationDelay: `${delayMs}ms` }}
      >
        {count}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Inline pictograph pills used inside the greeting headline.
 * Slightly larger now (0.92em) with a softer fill — reads as a real
 * pictograph adjacent to the headline word it modifies.
 * ------------------------------------------------------------------- */

function InlinePictograph({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center align-[-0.14em]",
        "size-[0.92em] rounded-[0.22em]",
        "bg-white/[0.18] ring-1 ring-inset ring-white/25 backdrop-blur-sm",
        "text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_4px_rgba(0,0,0,0.2)]",
      )}
    >
      {children}
    </span>
  );
}

type PillTone = "indigo" | "violet" | "peach" | "rose" | "amber";

function ContentPill({
  children,
  icon,
  avatar,
  tone = "indigo",
}: {
  children: ReactNode;
  icon?: ReactNode;
  avatar?: string;
  tone?: PillTone;
}) {
  const toneStyle: Record<PillTone, string> = {
    indigo: "bg-[#6f8be5]/40 text-white ring-white/25",
    violet: "bg-[#8b6fe5]/40 text-white ring-white/25",
    peach: "bg-[#e0a181]/40 text-white ring-white/25",
    rose: "bg-[#e58b8b]/40 text-white ring-white/25",
    amber: "bg-[#e5c081]/45 text-white ring-white/25",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.92em] font-medium leading-none",
        "ring-1 ring-inset backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]",
        toneStyle[tone],
      )}
    >
      {icon ? <span className="grid place-items-center text-white">{icon}</span> : null}
      {avatar ? (
        <span className="grid size-4 place-items-center rounded-full bg-white/30 text-[10px] font-bold text-white">
          {avatar}
        </span>
      ) : null}
      <span>{children}</span>
    </span>
  );
}
