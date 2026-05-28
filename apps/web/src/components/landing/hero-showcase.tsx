import { CalendarDays, Inbox as InboxIcon, Sun } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AuroraGlow } from "~/components/landing/aurora-glow";
import { DeviceBezel } from "~/components/landing/device-bezel";
import { InboxMockup } from "~/components/landing/inbox-mockup";
import { MeetingPrepMockup } from "~/components/landing/meeting-prep-mockup";
import { MorningBriefingPanel } from "~/components/landing/morning-briefing-panel";
import { TabPill } from "~/components/landing/tab-pill";
import {
  tabButtonId,
  tabPanelId,
  type TabPillOption,
} from "~/components/landing/tab-pill-ids";
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
 * that auto-loop through every two seconds with a soft crossfade + lift.
 * Inspired by visitors.now's tab-pill-above-product pattern, plus auto-cycling
 * so the page feels alive without the user clicking.
 *
 * Behavior:
 *   • Auto-advances `tab` every 2s (suspended when off-screen or hovered).
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
  const idBase = useId();
  // Hover + off-screen are pause signals only — they never appear in JSX
  // and shouldn't trigger re-renders. Refs let event handlers and the
  // IntersectionObserver flip them without rescheduling the interval.
  const hoverRef = useRef(false);
  const offScreenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auto-advance every AUTO_ADVANCE_MS. The interval is always live (under
  // reduced-motion it never starts), and each tick checks the pause refs.
  // Resetting on `tab` is what gives manual clicks a full interval before
  // the next auto-advance — any setTab() reschedules the next tick.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => {
      if (hoverRef.current || offScreenRef.current) return;
      setTab((current) => {
        const idx = TAB_VALUES.indexOf(current);
        const nextValue = TAB_VALUES[(idx + 1) % TAB_VALUES.length];
        return nextValue ?? current;
      });
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [tab]);

  // Pause the auto-cycle when the showcase isn't visible — saves a tab
  // landing on the wrong panel by the time the user scrolls down. Also
  // avoids burning CPU on a re-render no one sees.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        offScreenRef.current = !entry?.isIntersecting;
      },
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
    >
      <AuroraGlow />

      <div className="relative flex flex-col items-center">
        <TabPill options={TABS} value={tab} onChange={setTab} idBase={idBase} />

        <div className="relative mt-6 w-full">
          <DeviceBezel>
            <div className="relative grid">
              {TAB_VALUES.map((value) => (
                <Slot
                  key={value}
                  active={tab === value}
                  id={tabPanelId(idBase, value)}
                  labelledBy={tabButtonId(idBase, value)}
                >
                  {value === "briefing" && <MorningBriefingPanel className="rounded-none ring-0" />}
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
function Slot({
  active,
  id,
  labelledBy,
  children,
}: {
  active: boolean;
  id: string;
  labelledBy: string;
  children: ReactNode;
}) {
  const baseClassName =
    "[grid-area:1/1] transition-[opacity,transform,filter] duration-500 ease-out";
  // Split the active/inactive cases into two render paths so a static
  // a11y checker can see that `aria-hidden` is never paired with a
  // focusable `tabIndex` on the same element — a focusable subtree that's
  // aria-hidden confuses keyboard users.
  if (active) {
    return (
      <div
        id={id}
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
        className={cn(baseClassName, "opacity-100 z-10")}
        style={{ transform: "translateY(0) scale(1)" }}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      aria-hidden
      className={cn(baseClassName, "opacity-0 pointer-events-none blur-[2px]")}
      style={{ transform: "translateY(10px) scale(0.985)" }}
    >
      {children}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
