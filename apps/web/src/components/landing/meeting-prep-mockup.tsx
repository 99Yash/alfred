import { CalendarDays, Clock3 } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * Hero-grade meeting-prep mockup.
 *
 * Restructured 2026-05-23 to follow dimension's actual Meeting Prep design
 * (live recon while their site was still up — see notes in the redesign
 * journal). Their version uses **long-form prose briefings** in three named
 * sections (WORTH BRINGING UP / HEADS UP / etc.), layered over a faint
 * calendar mockup with a guest profile photo floating beside it. The earlier
 * "attendee tile row + colored chip ledger" iteration read as generic;
 * editorial prose feels like Alfred actually has a point of view.
 *
 * Vertical rhythm (still aligned with briefing + inbox panels):
 *   1. header ribbon (title + countdown chip)
 *   2. guest spotlight strip (avatar + name + role + last-met context)
 *   3. headline (single line — no orphans)
 *   4. dark briefing card with three prose sections
 */
export function MeetingPrepMockup({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative isolate h-full overflow-hidden rounded-none ring-0 text-left",
        "morning-briefing-surface",
        className,
      )}
    >
      {/* 1 — Header ribbon */}
      <div className="relative z-10 flex items-center justify-between gap-3 px-8 pt-7">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-medium uppercase tracking-[0.16em] text-white/60">
          <CalendarDays className="size-3.5 text-white/70" strokeWidth={2.2} />
          Meeting Prep · 3:00 PM
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/15 px-2.5 py-1 text-[11.5px] font-medium text-amber-200 ring-1 ring-inset ring-amber-300/30 backdrop-blur-sm">
          <Clock3 className="size-3" strokeWidth={2.4} />
          In 8 min
        </span>
      </div>

      {/* 2 — Guest spotlight */}
      <GuestSpotlight />

      {/* 3 — Headline (single line, no orphans) */}
      <div className="relative z-10 px-8 pt-6">
        <h2
          className={cn(
            "max-w-[32ch] text-balance font-semibold leading-[1.08] tracking-[-0.04em] text-white",
            "text-[28px] sm:text-[32px] lg:text-[34px]",
          )}
        >
          Walk in knowing what Anika's been thinking about.
        </h2>
      </div>

      {/* 4 — Editorial briefing card */}
      <BriefingCard />
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Guest spotlight — the meeting is fundamentally about the guest. Show
 * Anika prominently with her avatar, role, and a "last context" line. No
 * shell box; the spotlight floats directly on the blue panel surface (like
 * the integration tile row in briefing).
 * ------------------------------------------------------------------- */

function GuestSpotlight() {
  return (
    <div className="relative z-10 mt-6 flex items-center gap-4 px-8">
      {/* Large rounded avatar — rose tint to match the headline pill family */}
      <span
        aria-hidden
        className={cn(
          "relative grid size-14 shrink-0 place-items-center rounded-2xl",
          "bg-gradient-to-br from-[#eda4a4]/95 to-[#e58b8b]/80",
          "ring-1 ring-inset ring-white/30",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_6px_18px_-8px_rgba(0,0,0,0.45)]",
        )}
      >
        <span className="text-[20px] font-semibold leading-none text-white">
          A
        </span>
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <span className="text-[17px] font-semibold leading-tight text-white">
            Anika Sharma
          </span>
          <span className="text-[12.5px] font-medium uppercase tracking-[0.14em] text-white/55">
            Design Lead
          </span>
        </p>
        <p className="mt-1 text-[13px] leading-[1.45] text-white/70">
          You meet weekly. Last sync: notification redesign.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Briefing card — dark inner surface holding three labelled prose
 * sections (ON HER MIND / WORTH BRINGING UP / HEADS UP). Mirrors the dark
 * popover treatment dimension layers over its blue panel.
 * ------------------------------------------------------------------- */

interface BriefingSection {
  label: string;
  body: string;
}

const SECTIONS: ReadonlyArray<BriefingSection> = [
  {
    label: "On her mind",
    body: "Auth migration (ENG-341). Was blocked on staging for two days; she fixed it this morning and already has a PR up.",
  },
  {
    label: "Worth bringing up",
    body: "She mentioned wanting more architecture ownership last week. The notification redesign is open and she'd be a good fit.",
  },
  {
    label: "Heads up",
    body: "She Slacked at midnight about the staging blocker — not the type to complain, but two days of dead time frustrates her.",
  },
];

function BriefingCard() {
  return (
    <div className="relative z-10 mx-8 mt-6 mb-8 overflow-hidden rounded-2xl bg-black/40 ring-1 ring-inset ring-white/10 backdrop-blur-sm">
      <ul className="divide-y divide-white/10">
        {SECTIONS.map((section) => (
          <li key={section.label} className="px-5 py-4 sm:px-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">
              {section.label}
            </p>
            <p className="mt-1.5 text-[14px] leading-[1.55] text-white/90 sm:text-[14.5px]">
              {section.body}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
