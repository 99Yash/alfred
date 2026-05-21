import { CalendarDays, MessagesSquare, Sun, Video } from "lucide-react";
import type { ReactNode } from "react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

/**
 * The hero showcase panel — a translucent blue card mimicking Dimension's
 * "Morning Briefing" demo (which in the real dimension page is an MP4 clip).
 *
 * Three stacked chunks:
 *   1. `IntegrationTileRow` — five oversized frosted tiles with red unread
 *      badges (Gmail / Calendar / Slack / Linear / Notion-substitute).
 *   2. `StatusPill` — the "Alfred · Checking your schedule…" status row with
 *      a pulsing dot.
 *   3. The greeting block (city/temp ribbon → oversized greeting with inline
 *      pictograph pills → MORNING BRIEFING badge → content-pill ledger).
 *
 * Entirely static markup with CSS keyframes for the animation. Dimension's
 * source-of-truth versions are MP4s served from /videos/new-landing/.
 */
export function MorningBriefingPanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-[28px]",
        "ring-1 ring-inset ring-white/12",
        "shadow-[0_30px_80px_-30px_rgba(15,30,55,0.55)]",
        "morning-briefing-surface",
        className,
      )}
    >
      {/* Top weather/locale ribbon */}
      <div className="relative z-10 flex items-center gap-2 px-8 pt-7 text-white/85">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.16em] text-white/55">
          Mumbai
        </span>
        <span className="text-[12.5px] font-medium text-white/55">24°</span>
      </div>

      {/* --------------------- Integration tile row -------------------- */}
      <IntegrationTileRow />

      {/* --------------------- Status pill ----------------------------- */}
      <div className="relative z-10 flex justify-center px-8 pb-2 pt-1">
        <StatusPill />
      </div>

      {/* --------------------- Greeting headline ----------------------- */}
      <div className="relative z-10 px-8 pt-6">
        <h2
          className={cn(
            "font-medium leading-[1.06] tracking-[-0.02em] text-white",
            "text-[28px] sm:text-[32px] lg:text-[34px]",
          )}
        >
          Good Morning, Alex. <span className="text-white/95">You have</span>{" "}
          <InlinePill>
            <Video className="size-[0.5em]" strokeWidth={2.4} />
          </InlinePill>{" "}
          <span className="text-white">4 meetings</span>{" "}
          <span className="text-white/95">but a free</span>{" "}
          <InlinePill>
            <Sun className="size-[0.5em]" strokeWidth={2.4} />
          </InlinePill>{" "}
          <span className="text-white">afternoon.</span>
        </h2>
      </div>

      {/* Section badge + hairline divider */}
      <div className="relative z-10 mt-6 px-8">
        <div className="inline-flex items-center gap-2 rounded-full text-[12.5px] font-medium uppercase tracking-[0.18em] text-white/75">
          <span className="grid size-5 place-items-center rounded-md bg-white/15 ring-1 ring-inset ring-white/15 backdrop-blur-sm">
            <span className="block size-2 rounded-[2px] bg-white/85" />
          </span>
          Morning Briefing
        </div>
        <div className="mt-4 h-px w-full bg-gradient-to-r from-white/40 via-white/10 to-transparent" />
      </div>

      {/* Inline ledger of pill-tagged events */}
      <div className="relative z-10 space-y-3 px-8 pb-8 pt-4 text-[15px] leading-[1.5] text-white/92 sm:text-[16px]">
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
    <div className="relative z-10 mx-auto mt-6 flex w-fit items-center justify-center gap-5 rounded-[42px] bg-black/15 px-6 py-4 backdrop-blur-sm">
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
          "block size-16 shrink-0 rounded-2xl ring-1 ring-inset ring-white/30",
          "bg-gradient-to-br from-white/95 to-white/75",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_4px_18px_-8px_rgba(0,0,0,0.5)]",
          "grid place-items-center backdrop-blur-sm",
        )}
      >
        <IntegrationGlyph
          brand={brand}
          size={32}
          variant="plain"
          colorOverride={brand === "github" ? "#181717" : undefined}
        />
      </span>
      <span
        className={cn(
          "absolute -right-2 -top-2 grid size-7 place-items-center rounded-full",
          "bg-[#ff3a3a] text-[12px] font-semibold text-white tabular",
          "ring-2 ring-[#4867AF] shadow-[0_2px_8px_-2px_rgba(255,58,58,0.5)]",
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
 * "Alfred · Checking your schedule…" status pill with a pulsing dot.
 * ------------------------------------------------------------------- */

function StatusPill() {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-3 rounded-full bg-black/35 px-4 py-2",
        "ring-1 ring-inset ring-white/10 backdrop-blur-sm",
        "text-[13px] font-medium text-white/90",
      )}
    >
      <span className="inline-flex items-center gap-2">
        <span className="grid size-5 place-items-center rounded-full bg-white text-[10px] font-bold text-black">
          A
        </span>
        Alfred
      </span>
      <span aria-hidden className="h-3 w-px bg-white/15" />
      <span className="inline-flex items-center gap-1.5 text-white/75">
        <span className="relative grid size-2.5 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-300/70" />
          <span className="relative size-1.5 rounded-full bg-emerald-300" />
        </span>
        Checking your schedule…
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Inline pictograph pills used inside the greeting headline.
 * ------------------------------------------------------------------- */

function InlinePill({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center align-[-0.12em]",
        "size-[0.78em] rounded-[0.18em]",
        "bg-white/[0.22] ring-1 ring-inset ring-white/30 backdrop-blur-sm",
        "text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_1px_4px_rgba(0,0,0,0.18)]",
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
