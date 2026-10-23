import { useState } from "react";
import { m } from "motion/react";
import { cn } from "~/lib/utils";
import { CHAT_PANEL, usePrefersReducedMotion, type LiveTransition } from "../motion";
import type { ChatSidePanelMode, RailTab } from "./models";
import { RailContent } from "./rail-content";
import { EMPTY_RAIL_DATA, type RailData } from "./rail-data";

/* -------------------------------------------------------------------------- */
/* Right rail (Today): inline at ≥1280px, overlay below. Data comes in props.  */
/* -------------------------------------------------------------------------- */

interface RightRailProps {
  open: boolean;
  mode: ChatSidePanelMode;
  onClose: () => void;
  data?: RailData | undefined;
}

export function RightRail({ open, mode, onClose, data = EMPTY_RAIL_DATA }: RightRailProps) {
  const [tab, setTab] = useState<RailTab>("todo");

  // Live reduced-motion value for the inline motion tween below. Unconditional:
  // the overlay branch returns early.
  const reduce = usePrefersReducedMotion();

  if (mode === "overlay") {
    return (
      <>
        <button
          type="button"
          aria-label="Close panel"
          tabIndex={open ? 0 : -1}
          onClick={onClose}
          className={cn(
            "fixed inset-0 z-40 bg-app-background/40 backdrop-blur-[2px]",
            "transition-opacity duration-200",
            open ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
        <aside
          aria-label="Today"
          aria-hidden={!open}
          className={cn(
            "fixed inset-y-0 right-0 z-50 w-[340px] max-w-[88vw]",
            "border-l border-app-bg-3/60 bg-transparent",
            "flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
            // Slides in and out on the right; reduced motion gets a fade (apple-design §14).
            "transition-transform duration-200 ease-out motion-reduce:transition-opacity",
            "overflow-hidden",
            open
              ? "translate-x-0 motion-reduce:opacity-100"
              : "translate-x-full motion-reduce:opacity-0",
          )}
        >
          <RailContent tab={tab} onTabChange={setTab} onClose={onClose} showClose data={data} />
        </aside>
      </>
    );
  }

  // Inline: a motion width tween on `CHAT_PANEL`, the same transition value as
  // the artifact clip box. One source and one clock, so the slot width stays on
  // one curve during a swap. `initial={false}` skips a tween on mount.
  // `-6` cancels the `gap-1.5` of the shell's `<main>` while closed, as the artifact panel does.
  const transition: LiveTransition = {
    ...(reduce ? { duration: 0 } : CHAT_PANEL),
    reduceMotion: reduce,
  };

  return (
    <m.aside
      aria-label="Today"
      initial={false}
      animate={{ width: open ? 340 : 0, marginLeft: open ? 0 : -6 }}
      transition={transition}
      className={cn(
        "h-full shrink-0",
        "rounded-2xl bg-transparent",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
        // `overflow-hidden` keeps the rounded corners over full-bleed children (video, scrims).
        "overflow-hidden",
        !open && "pointer-events-none",
      )}
    >
      <div className="relative flex h-full w-[340px] flex-col">
        <RailContent tab={tab} onTabChange={setTab} data={data} />
      </div>
    </m.aside>
  );
}
