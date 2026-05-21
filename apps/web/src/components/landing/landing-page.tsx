import {
  ArrowRight,
  CalendarDays,
  Inbox,
  Lock,
  MessagesSquare,
  Sparkles,
  Sun,
  Timer,
  Video,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  FloatingPillNav,
  FrostButton,
  HeroAtmosphere,
  LandingCtaSection,
  LandingFooter,
  MorningBriefingPanel,
  TopAnnouncement,
} from "~/components/landing";
import { useScrollProgress } from "~/lib/use-scroll-progress";
import { cn } from "~/lib/utils";

/**
 * Dimension-grammar marketing landing for Alfred. Sticky left column (intro,
 * headline, bullets, CTA, numbered capability TOC) + a right pane that holds
 * one full-viewport showcase section per capability. The TOC tracks the
 * active section via IntersectionObserver; clicking a TOC item smooth-scrolls
 * that section into view.
 */
export function LandingPage({
  healthOk,
  healthLoading,
}: {
  healthOk: boolean;
  healthLoading: boolean;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const localTime = useLocalTime();
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const scrollProgress = useScrollProgress(scrollRootRef);

  // Track the visible capability section via IntersectionObserver. The root
  // is the outer scroll container so threshold math is relative to the
  // visible viewport, not the document.
  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        // Prefer the entry with the highest intersection ratio — handles the
        // moment two sections overlap during a snap transition.
        let best: { index: number; ratio: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.idx);
          if (Number.isNaN(idx)) continue;
          if (!best || entry.intersectionRatio > best.ratio) {
            best = { index: idx, ratio: entry.intersectionRatio };
          }
        }
        if (best) setActiveIndex(best.index);
      },
      { root, threshold: [0.4, 0.6, 0.8] },
    );

    for (const el of sectionRefs.current) {
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  const scrollToSection = useCallback((idx: number) => {
    const el = sectionRefs.current[idx];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div
      ref={scrollRootRef}
      className={cn(
        "relative isolate h-[100dvh] overflow-y-auto overflow-x-hidden overscroll-none",
        // `snap-mandatory` snaps every gesture to a section. Combined with
        // the hidden scrollbar this matches dimension's scroll feel — but
        // ONLY on lg+. On phones the left rail (which has no snap-start)
        // is taller than the viewport, and mandatory snapping rips users
        // past the bottom of the TOC before they can read it. `snap-none`
        // on mobile lets thumb gestures scroll naturally.
        "snap-y snap-none lg:snap-mandatory hide-scrollbar bg-[#0c0c0c]",
      )}
    >
      <TopAnnouncement href="#features" dotClassName="bg-amber-200/70">
        Alfred — your personal AI assistant
      </TopAnnouncement>

      <HeroAtmosphere className="relative min-h-[100dvh]" progress={scrollProgress}>
        <div className="mx-auto flex w-full max-w-[100rem] flex-col lg:flex-row">
          {/* Left column — sticky on desktop. Holds intro label, headline,
            * bullets, primary CTA, and the numbered capability TOC. */}
          <aside
            className={cn(
              "relative shrink-0 px-6 sm:px-10",
              "lg:sticky lg:top-0 lg:h-[100dvh] lg:max-w-[32rem] lg:pl-10 lg:pr-12",
              "lg:border-r-[0.5px] lg:border-black/10",
              "pt-24 pb-12 lg:pt-20 lg:pb-10",
            )}
          >
            <div className="flex h-full max-w-lg flex-col">
              <p className="text-[15px] font-medium text-white">Introducing Alfred</p>
              <h1
                className={cn(
                  "mt-4 max-w-[18rem] text-balance font-medium text-white sm:max-w-none",
                  "text-4xl sm:text-5xl leading-[1.05] tracking-[-0.02em]",
                )}
              >
                The AI coworker that never sleeps.
              </h1>

              <ul className="mt-7 flex flex-col gap-3 text-white">
                <Bullet icon={<Sparkles className="size-4" strokeWidth={2} />}>
                  Triages your inbox, drafts replies in your tone
                </Bullet>
                <Bullet icon={<Timer className="size-4" strokeWidth={2} />}>
                  Briefs you each morning and after every meeting
                </Bullet>
                <Bullet icon={<MessagesSquare className="size-4" strokeWidth={2} />}>
                  Chat from the web, mobile, or your terminal
                </Bullet>
                <Bullet icon={<Lock className="size-4" strokeWidth={2} />}>
                  Your data, your keys — never used for training
                </Bullet>
              </ul>

              <div className="mt-7 flex items-center gap-3">
                <FrostButton
                  tone="light"
                  onClick={() => {
                    window.location.assign("/login");
                  }}
                >
                  Get Started
                  <ArrowRight className="size-3.5" />
                </FrostButton>
                <span className="text-xs text-white/55">
                  {healthLoading
                    ? "checking server…"
                    : healthOk
                      ? "server online"
                      : "server unreachable"}
                </span>
              </div>

              {/* Capability TOC — pushed to the bottom of the column on desktop */}
              <div className="mt-10 lg:mt-auto lg:pt-10">
                <h2 className="mb-3 text-[17px] font-semibold text-white">
                  What Alfred handles for you
                </h2>
                <ul className="flex flex-col items-start lg:max-h-80 lg:overflow-y-auto">
                  {CAPABILITIES.map((cap, idx) => (
                    <li key={cap.id} className="w-full">
                      <button
                        type="button"
                        onClick={() => scrollToSection(idx)}
                        className={cn(
                          "group flex w-full select-none items-center justify-between rounded-[10px] p-2",
                          "text-[15px] text-white transition-colors duration-200",
                          activeIndex === idx
                            ? "bg-white/[0.05]"
                            : "hover:bg-white/[0.03]",
                        )}
                      >
                        <div className="flex items-center">
                          <span
                            className="flex shrink-0 items-center"
                            style={{ width: "auto", marginRight: 6 }}
                          >
                            <span
                              className={cn(
                                "block h-5 w-[3px] rounded-[2px] transition-opacity duration-200",
                                activeIndex === idx
                                  ? "bg-[#73A7FF] opacity-100"
                                  : "bg-[#73A7FF] opacity-0",
                              )}
                            />
                          </span>
                          {cap.label}
                        </div>
                        <span className="font-medium text-white/75 mix-blend-plus-lighter tabular">
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </aside>

          {/* Right pane — stacked capability sections. Each section is a
            * snap-start full-viewport panel. The vertical tick ruler is a
            * single fixed-to-pane element so it covers the whole stack.
            * `bg-black/10` only kicks in at `lg` where the pane sits next
            * to the aside — on mobile the pane stacks BELOW the aside and
            * the band would read as a visible horizontal seam. */}
          <section className="relative z-10 grow lg:bg-black/10">
            {/* Vertical tick ruler running down the left edge of the pane */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <svg
                aria-hidden
                className="absolute top-0 z-10 box-content h-full w-2 border-r border-white/10 px-1.5 pt-1"
              >
                <defs>
                  <pattern
                    id="landing-tick-ruler"
                    width="8"
                    height="16"
                    patternUnits="userSpaceOnUse"
                  >
                    <path d="M0 0H16M0" className="stroke-white/40" fill="none" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#landing-tick-ruler)" />
              </svg>
            </div>

            {/* SHARED sticky locale ribbon — one for the whole pane, not one
              * per section. Its text comes from the active capability so it
              * "labels" whichever section is in view. Replaces the per-section
              * ribbons that used to stack and bleed during scroll-snap. */}
            <SharedLocaleRibbon
              localTime={localTime}
              label={CAPABILITIES[activeIndex]?.label ?? ""}
            />

            {CAPABILITIES.map((cap, idx) => (
              <CapabilitySection
                key={cap.id}
                ref={(node) => {
                  sectionRefs.current[idx] = node;
                }}
                idx={idx}
                capability={cap}
              >
                <cap.demo />
              </CapabilitySection>
            ))}
          </section>
        </div>

        {/* Closing CTA — sibling of the hero flex-row so it sits inside the
          * same `HeroAtmosphere` and shares the sky-gradient backdrop. The
          * sticky left rail stops being visible here because its containing
          * block (the flex-row above) ends. */}
        <LandingCtaSection
          onGetStarted={() => {
            window.location.assign("/login");
          }}
        />

        {/* Rounded-bottom white cap that "rises" out of the sky — bridges the
          * dark sky and the LIGHT footer below. Matches dimension's
          * `rounded-b-[64px] bg-white drop-shadow-lg` strip. */}
        <div
          aria-hidden
          className="relative z-10 h-8 rounded-b-[64px] bg-white drop-shadow-[0_8px_24px_rgba(0,0,0,0.18)] md:h-16"
        />
      </HeroAtmosphere>

      {/* Light footer — sits OUTSIDE HeroAtmosphere so the night sky doesn't
        * bleed through. Dimension's exact recipe: light gradient bg + grid
        * hairlines + corner dots + neumorphic headers. */}
      <LandingFooter
        onGetStarted={() => {
          window.location.assign("/login");
        }}
      />

      <FloatingPillNav
        logo={
          <a href="/" className="flex items-center gap-2">
            <span className="grid size-5 place-items-center rounded-full bg-white text-[10px] font-bold text-black">
              A
            </span>
            <span className="text-sm font-semibold text-white">Alfred</span>
          </a>
        }
        cta={
          <FrostButton
            tone="light"
            size="sm"
            onClick={() => {
              window.location.assign("/login");
            }}
          >
            Get Started
          </FrostButton>
        }
      >
        <a
          href="#features"
          className="rounded-full px-3.5 py-2 text-sm font-medium leading-[100%] text-white/85 transition-colors hover:bg-black/10 hover:text-white"
        >
          Features
        </a>
        <a
          href="#use-cases"
          className="rounded-full px-3.5 py-2 text-sm font-medium leading-[100%] text-white/85 transition-colors hover:bg-black/10 hover:text-white"
        >
          Use Cases
        </a>
        <a
          href="#pricing"
          className="rounded-full px-3.5 py-2 text-sm font-medium leading-[100%] text-white/85 transition-colors hover:bg-black/10 hover:text-white"
        >
          Pricing
        </a>
      </FloatingPillNav>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section + bullet primitives                                        */
/* ------------------------------------------------------------------ */

function CapabilitySection({
  idx,
  capability,
  children,
  ref,
}: {
  idx: number;
  capability: Capability;
  children: ReactNode;
  ref?: (node: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={ref}
      data-idx={idx}
      id={capability.id}
      className={cn(
        "relative flex min-h-[100dvh] snap-start flex-col pl-5",
        // `scroll-mt` leaves room for the shared sticky locale ribbon when
        // snapping. Ribbon is taller on phones (extra top padding to clear
        // the floating TopAnnouncement), so bump the mobile value.
        "scroll-mt-[104px] lg:scroll-mt-[88px]",
      )}
    >
      <div className="relative flex flex-col">
        <div className="mx-auto flex w-full flex-col pl-10 pr-6 pt-[140px] pb-32 sm:pr-10 lg:pt-[120px]">
          <div className="mb-6 flex flex-col gap-1.5">
            <h3 className="text-[34px] font-medium leading-tight tracking-[-0.02em] text-white sm:text-[36px]">
              {capability.label}
            </h3>
            <p className="max-w-2xl pr-10 text-[15px] text-white/85">
              {capability.description}
            </p>
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * ONE sticky locale ribbon for the whole right pane. Lives at the top of the
 * pane and stays pinned across all seven capability sections; its text is
 * driven by `activeIndex` so the label updates as you scroll between
 * sections without ever stacking two ribbons on top of each other.
 *
 * Backdrop uses `backdrop-blur-2xl` instead of a flat colour so the ribbon
 * naturally tints to whatever sky-layer is behind it (morning blue → dusk
 * indigo → night), while still masking content scrolling underneath.
 */
function SharedLocaleRibbon({
  localTime,
  label,
}: {
  localTime: string;
  label: string;
}) {
  return (
    <div className="sticky top-0 z-30">
      <div
        aria-hidden
        className="absolute inset-0 left-5 bg-black/[0.18] backdrop-blur-2xl backdrop-saturate-150"
      />
      {/* `pt-14` on phones pushes the ribbon text below the floating
        * `TopAnnouncement` pill (fixed at `top-3`, ~24px tall). On lg+ the
        * announcement aligns with the left rail and the ribbon can sit
        * higher. */}
      <div className="relative ml-5 w-[calc(100%-20px)] pt-14 pb-3 lg:pt-8">
        <p className="pl-5 text-[12.5px] font-bold uppercase tracking-[0.16em] text-white/65 mix-blend-plus-lighter">
          Mumbai · {localTime} · {label}
        </p>
        <div
          className="relative mt-4 h-[0.5px] w-full"
          style={{
            background:
              "linear-gradient(90deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.55) 100%)",
          }}
        >
          {/* Circle marker — sits just outside the line's left edge. */}
          <span
            aria-hidden
            className="absolute -left-[4.5px] -top-[5px] z-40 grid size-2.5 place-items-center rounded-full bg-white/10"
          >
            <span className="size-1 rounded-full bg-white" />
          </span>
          {/* Dash marker — runs into the circle from further left. */}
          <span
            aria-hidden
            className="absolute -left-[14px] top-1/2 z-40 -translate-y-1/2"
          >
            <span className="block h-[0.5px] w-4 bg-white" />
          </span>
        </div>
      </div>
    </div>
  );
}

function Bullet({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 text-white" aria-hidden>
        {icon}
      </span>
      <span className="text-[15px] text-white">{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Capability catalog                                                 */
/* ------------------------------------------------------------------ */

interface Capability {
  id: string;
  label: string;
  description: string;
  demo: () => ReactNode;
}

const CAPABILITIES: ReadonlyArray<Capability> = [
  {
    id: "morning-briefing",
    label: "Morning Briefing",
    description:
      "Alfred collates overnight updates from your connected integrations into a single briefing so you start your day with clarity.",
    demo: () => <MorningBriefingPanel />,
  },
  {
    id: "catch-up",
    label: "Catch Up",
    description:
      "Coming back from focus? A concise digest of what changed across your apps while you were heads-down.",
    demo: () => (
      <DemoPanel
        eyebrow="Catch Up"
        headline="You missed 12 things — only 3 need you."
        rows={[
          { label: "Linear", text: "ENG-204 moved to 'In Review' by Priya" },
          { label: "GitHub", text: "alfred-core#481 needs a re-review" },
          { label: "Slack", text: "#launch — Dana asked about timeline" },
        ]}
      />
    ),
  },
  {
    id: "action-plan",
    label: "Action Plan",
    description:
      "Alfred turns scattered asks into an ordered plan, with the next tangible step always on top.",
    demo: () => (
      <DemoPanel
        eyebrow="Action Plan · Today"
        headline="3 next steps · 1 hour of focus."
        rows={[
          { label: "Now", text: "Reply to Dana with the migration timeline" },
          { label: "Next", text: "Push the cold-start research patch" },
          { label: "After standup", text: "Draft the m11 retro outline" },
        ]}
      />
    ),
  },
  {
    id: "deep-work",
    label: "Deep Work",
    description:
      "Alfred holds the line on focus blocks, defers interruptions, and surfaces only what genuinely can't wait.",
    demo: () => (
      <DemoPanel
        eyebrow="Deep Work · 90 min block"
        headline="Holding the line. 7 alerts deferred."
        rows={[
          { label: "Deferred", text: "Slack mentions in #random, #design" },
          { label: "Deferred", text: "Newsletters, low-pri Gmail labels" },
          { label: "Surfaced", text: "PagerDuty alert from auth-svc (1)" },
        ]}
      />
    ),
  },
  {
    id: "inbox",
    label: "Inbox",
    description:
      "Triage every message into Reply, Read, or Archive. Drafts replies in your tone — you just press send.",
    demo: () => (
      <DemoPanel
        eyebrow="Inbox · today"
        headline="38 emails · 4 worth replying to."
        rows={[
          { label: "Reply", text: "Anika — auth migration follow-up" },
          { label: "Reply", text: "Dana — Q3 roadmap thread" },
          { label: "Read", text: "Vercel — domain settings updated" },
          { label: "Archive", text: "29 newsletters + receipts (auto)" },
        ]}
      />
    ),
  },
  {
    id: "meeting-prep",
    label: "Meeting Prep",
    description:
      "Before each meeting, Alfred briefs you on who's attending, key talking points, and past context so you walk in prepared.",
    demo: () => (
      <DemoPanel
        eyebrow="Meeting Prep · 3:00 PM"
        headline="Design Meeting with Anika."
        rows={[
          { label: "On her mind", text: "Auth migration (ENG-341) — staged today" },
          { label: "Worth raising", text: "Architecture ownership for notif redesign" },
          { label: "Heads up", text: "She Slacked at midnight about staging" },
        ]}
      />
    ),
  },
  {
    id: "daily-recap",
    label: "Daily Recap",
    description:
      "An evening summary of decisions, follow-ups, and open threads so nothing slips overnight.",
    demo: () => (
      <DemoPanel
        eyebrow="Daily Recap · Wed, May 20"
        headline="Shipped 2 PRs. 1 thread left open."
        rows={[
          { label: "Shipped", text: "alfred-core#481 — cold-start research wiring" },
          { label: "Shipped", text: "alfred-web#62 — landing redesign" },
          { label: "Open", text: "Dana's Q3 roadmap question — reply tomorrow" },
        ]}
      />
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Generic demo panel — same visual language as MorningBriefingPanel  */
/* but with an arbitrary set of labeled rows. Used for capabilities   */
/* 2-7 to keep the showcase consistent.                               */
/* ------------------------------------------------------------------ */

function DemoPanel({
  eyebrow,
  headline,
  rows,
}: {
  eyebrow: string;
  headline: string;
  rows: ReadonlyArray<{ label: string; text: string }>;
}) {
  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-[28px]",
        "ring-1 ring-inset ring-white/12",
        "shadow-[0_30px_80px_-30px_rgba(15,30,55,0.55)]",
        "morning-briefing-surface",
      )}
    >
      <div className="relative z-10 flex items-center gap-2 px-8 pt-7 text-white/85">
        <span className="text-[12.5px] font-medium uppercase tracking-[0.16em] text-white/55">
          {eyebrow}
        </span>
      </div>

      <div className="relative z-10 px-8 pb-2 pt-3">
        <h2 className="text-[34px] font-medium leading-[1.08] tracking-[-0.02em] text-white sm:text-[40px] lg:text-[44px]">
          {headline}
        </h2>
      </div>

      <div className="relative z-10 mt-6 px-8">
        <div className="h-px w-full bg-gradient-to-r from-white/40 via-white/10 to-transparent" />
      </div>

      <ul className="relative z-10 divide-y divide-white/[0.08] px-8 pb-9 pt-2">
        {rows.map((row) => (
          <li
            key={`${row.label}-${row.text}`}
            className="flex items-start gap-4 py-3 text-[16px] leading-[1.5] text-white/92"
          >
            <span className="mt-[3px] inline-flex shrink-0 items-center rounded-md bg-white/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-white ring-1 ring-inset ring-white/20 backdrop-blur-sm">
              {row.label}
            </span>
            <span className="min-w-0 flex-1 text-white/90">{row.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Export — kept so the icons in this module stay reachable if a sibling
// component wants to render them.
export const CapabilityIcons: Record<string, LucideIcon> = {
  CalendarDays,
  Inbox,
  Sun,
  Video,
  Workflow,
};

/**
 * Returns the user's local time as `HH:MM` (24h). Re-ticks every minute so the
 * timeline header stays accurate while the tab is open.
 */
function useLocalTime(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
