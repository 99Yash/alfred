import { CalendarDays, Inbox as InboxIcon, Sun } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DeviceBezel } from "~/components/landing/device-bezel";
import { HeroBand } from "~/components/landing/hero-band";
import { InboxMockup } from "~/components/landing/inbox-mockup";
import { MeetingPrepMockup } from "~/components/landing/meeting-prep-mockup";
import { MorningBriefingPanel } from "~/components/landing/morning-briefing-panel";
import { TabPill } from "~/components/landing/tab-pill";
import { tabButtonId, tabPanelId, type TabPillOption } from "~/components/landing/tab-pill-ids";
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
    // Meeting prep is designed and specified (ADR-0054) but has no module,
    // table, or tool yet. The clip shows the intended surface, so the tab
    // says so rather than letting the panel imply it ships today.
    badge: "Soon",
  },
];

const TAB_VALUES: ReadonlyArray<ShowcaseTab> = TABS.map((t) => t.value);

// Per-tab dwell time, tuned to each tab's content rather than a flat
// interval. The briefing clip does its whole reveal (greeting + ledger
// animate in) in the first few seconds and then just holds, so it advances
// quickly — no point sitting on a static frame. The inbox needs longer for
// its auto-tagging sequence to actually play. The meeting-prep still just
// needs a comfortable reading beat.
const TAB_DURATION_MS: Record<ShowcaseTab, number> = {
  briefing: 4200,
  inbox: 5000,
  meetings: 5000,
};

/**
 * Hero product showcase — the page's one full-bleed moment.
 *
 * Composition (see HeroBand for why the band is edge-to-edge): an indigo
 * aurora band spans the viewport, the tab row hangs off its top edge in a
 * page-colored notch, and the device bezel sits inside the band on the normal
 * `max-w-5xl` column. The control is on the page side of the boundary, the
 * thing it controls is inside the band — so which one drives which needs no
 * explaining. Grammar borrowed from visitors.now, re-registered for a dark
 * canvas.
 *
 * Behavior:
 *   • Auto-advances after each tab's own dwell time (TAB_DURATION_MS), so a
 *     tab's clip plays through before the next tab takes over. Suspended
 *     when off-screen or hovered.
 *   • The newly-active tab's clip restarts from frame 0 (see Slot/`active`),
 *     so you always see the animation from the start, not mid-loop.
 *   • Manual click swaps tab AND resets the cycle so the new tab sits for
 *     its full dwell before advancing.
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

  // Auto-advance after the current tab's dwell time. The effect re-runs on
  // every `tab` change, so the interval period always reflects the tab now
  // showing — effectively a self-rescheduling timeout. Each tick checks the
  // pause refs; if paused it skips advancing and retries next period. A
  // manual click changes `tab`, which restarts the dwell from the top.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = window.setInterval(() => {
      if (hoverRef.current || offScreenRef.current) return;
      setTab((current) => {
        const idx = TAB_VALUES.indexOf(current);
        const nextValue = TAB_VALUES[(idx + 1) % TAB_VALUES.length];
        return nextValue ?? current;
      });
    }, TAB_DURATION_MS[tab]);
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
      <HeroBand
        notch={
          <TabPill
            options={TABS}
            value={tab}
            onChange={setTab}
            idBase={idBase}
            // The notch already supplies the container shape. A bordered
            // glass pill inside it would read as two nested containers.
            variant="bare"
          />
        }
      >
        <DeviceBezel>
          {/* Fixed aspect so every tab is the same device size — the three
           * clips all fill one box, so the bezel never resizes (and the
           * crossfade never jumps) when the tab auto-advances. 1.29:1 matches
           * the inbox and meeting clips' native aspect exactly; the briefing
           * clip is slightly taller, so `object-top` plus its bottom edge fade
           * resolves the overflow instead of guillotining it. */}
          <div className="relative grid aspect-[1.29/1]">
            {TAB_VALUES.map((value) => (
              <Slot
                key={value}
                active={tab === value}
                id={tabPanelId(idBase, value)}
                labelledBy={tabButtonId(idBase, value)}
              >
                {value === "briefing" && <MorningBriefingPanel active={tab === value} />}
                {value === "inbox" && <InboxMockup active={tab === value} />}
                {value === "meetings" && <MeetingPrepMockup active={tab === value} />}
              </Slot>
            ))}
          </div>
        </DeviceBezel>
      </HeroBand>
    </div>
  );
}

/**
 * One stacked mockup in the showcase grid. All slots occupy the same grid
 * cell (`[grid-area:1/1]`), so the parent's height is the MAX of all
 * children — the visible mockup is always fully shown, the inactive ones
 * fade out behind. Inactive slots also get `pointer-events-none` so they
 * never intercept clicks meant for the visible mockup beneath/above.
 *
 * The outgoing panel loses a little scale and gains a little blur while the
 * incoming one arrives at rest. That is the material arriving and departing
 * rather than two opacities crossing, and it reads as depth: the old panel
 * moves back, the new one is here.
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
  const baseClassName = cn(
    "h-full overflow-hidden [grid-area:1/1]",
    "transition-[opacity,transform,filter] duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
    "motion-reduce:transition-none",
  );
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
        className={cn(baseClassName, "z-10 opacity-100")}
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
      className={cn(baseClassName, "pointer-events-none opacity-0 blur-[3px]")}
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
