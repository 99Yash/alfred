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
    // Meeting prep is not built yet (ADR-0054), so the clip must not imply it ships.
    badge: "Soon",
  },
];

const TAB_VALUES: ReadonlyArray<ShowcaseTab> = TABS.map((t) => t.value);

// Dwell per tab: long enough for each clip's animation to play.
const TAB_DURATION_MS = {
  briefing: 4200,
  inbox: 5000,
  meetings: 5000,
} satisfies Record<ShowcaseTab, number>;

/**
 * Hero product showcase: tabs in a notch above an aurora band, clips in a device bezel.
 * Auto-advances per tab; pauses when hovered or off-screen; off under reduced motion.
 * All clips share one grid cell, so the height never jumps.
 */
export function HeroShowcase({ className }: { className?: string }) {
  const [tab, setTab] = useState<ShowcaseTab>("briefing");
  const idBase = useId();
  // Refs, not state: pause signals must not reschedule the interval or re-render.
  const hoverRef = useRef(false);
  const offScreenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Re-runs on each `tab` change, so a manual click restarts the dwell.
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
            // The notch is the container; a glass pill inside would nest two.
            variant="bare"
          />
        }
      >
        <DeviceBezel>
          {/* Fixed 1.29:1 box (the inbox and meeting clips' aspect) so the bezel never resizes.
           * The taller briefing clip uses `object-top` and a bottom fade. */}
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
 * One stacked mockup. Inactive slots fade, scale down, blur, and take no pointer events.
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

  // Two render paths so a static a11y check sees `aria-hidden` never meets a focusable `tabIndex`.
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
