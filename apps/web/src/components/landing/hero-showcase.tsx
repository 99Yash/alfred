import { CalendarDays, Inbox as InboxIcon, Sun } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AuroraGlow } from "~/components/landing/aurora-glow";
import { DeviceBezel } from "~/components/landing/device-bezel";
import { InboxMockup } from "~/components/landing/inbox-mockup";
import { MeetingPrepMockup } from "~/components/landing/meeting-prep-mockup";
import { MorningBriefingPanel } from "~/components/landing/morning-briefing-panel";
import { TabPill, type TabPillOption } from "~/components/landing/tab-pill";
import { cn } from "~/lib/utils";

type ShowcaseTab = "briefing" | "inbox" | "meetings";

const TABS: ReadonlyArray<TabPillOption<ShowcaseTab>> = [
  {
    value: "briefing",
    label: "Briefing",
    icon: <Sun className="size-3.5" strokeWidth={2.2} />,
  },
  {
    value: "inbox",
    label: "Inbox",
    icon: <InboxIcon className="size-3.5" strokeWidth={2.2} />,
  },
  {
    value: "meetings",
    label: "Meeting Prep",
    icon: <CalendarDays className="size-3.5" strokeWidth={2.2} />,
  },
];

const TAB_VALUES: ReadonlyArray<ShowcaseTab> = TABS.map((t) => t.value);
const AUTO_ADVANCE_MS = 2000;

/**
 * Hero product showcase — three Alfred views (briefing / inbox / meeting prep)
 * that auto-loop through every five seconds with a soft crossfade + lift.
 * Inspired by visitors.now's tab-pill-above-product pattern, plus auto-cycling
 * so the page feels alive without the user clicking.
 *
 * Behavior:
 *   • Auto-advances `tab` every 5s (suspended when off-screen or hovered).
 *   • Manual click swaps tab AND resets the cycle so the new tab sits for
 *     the full interval before advancing.
 *   • Respects `prefers-reduced-motion`: no transitions, no auto-advance.
 *
 * Layout:
 *   • All three mockups stacked in CSS grid (same grid-area), so the
 *     container's height is always the MAX of the three. Each mockup
 *     fades + lifts independently. No measure-then-paint flicker.
 */
export function HeroShowcase({ className }: { className?: string }) {
  const [tab, setTab] = useState<ShowcaseTab>("briefing");
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-advance every AUTO_ADVANCE_MS, suspended when paused (hover) or
  // when the showcase is scrolled out of view. Resetting on `tab` is what
  // gives manual clicks a full interval before the next auto-advance — any
  // setTab() (manual or auto) reschedules the next tick.
  useEffect(() => {
    if (paused) return;
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => {
      setTab((current) => {
        const idx = TAB_VALUES.indexOf(current);
        const nextValue = TAB_VALUES[(idx + 1) % TAB_VALUES.length];
        return nextValue ?? current;
      });
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused, tab]);

  // Pause the auto-cycle when the showcase isn't visible — saves a tab
  // landing on the wrong panel by the time the user scrolls down. Also
  // avoids burning CPU on a re-render no one sees.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setPaused(!entry?.isIntersecting),
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <AuroraGlow />

      <div className="relative flex flex-col items-center">
        <TabPill options={TABS} value={tab} onChange={setTab} />

        <div className="relative mt-6 w-full">
          <DeviceBezel>
            <div className="relative grid">
              {TAB_VALUES.map((value) => (
                <Slot key={value} active={tab === value}>
                  {value === "briefing" && (
                    <MorningBriefingPanel className="rounded-none ring-0" />
                  )}
                  {value === "inbox" && <InboxMockup />}
                  {value === "meetings" && <MeetingPrepMockup />}
                </Slot>
              ))}
            </div>
          </DeviceBezel>
        </div>
      </div>
    </div>
  );
}

/**
 * One stacked mockup in the showcase grid. All slots occupy the same grid
 * cell (`[grid-area:1/1]`), so the parent's height is the MAX of all
 * children — the visible mockup is always fully shown, the inactive ones
 * fade out behind. Inactive slots also get `pointer-events-none` so they
 * never intercept clicks meant for the visible mockup beneath/above.
 */
function Slot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "[grid-area:1/1] transition-[opacity,transform,filter] duration-500 ease-out",
        active
          ? "opacity-100 z-10"
          : "opacity-0 pointer-events-none blur-[2px]",
      )}
      // Inline transform so Tailwind v4's transform-variable composition
      // doesn't fight with the `transition-all` shorthand. Outgoing mockup
      // lifts 10px while scaling down a touch; active sits at rest.
      style={{
        transform: active
          ? "translateY(0) scale(1)"
          : "translateY(10px) scale(0.985)",
      }}
    >
      {children}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
