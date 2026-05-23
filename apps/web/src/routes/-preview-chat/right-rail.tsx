import { useState } from "react";
import { cn } from "~/lib/utils";
import type { RailMode, RailTab } from "./helpers";
import { RailContent } from "./rail-content";

/* -------------------------------------------------------------------------- */
/* Right rail — Today panel                                                    */
/*                                                                            */
/* Two layout modes driven by viewport width:                                 */
/*  • inline  (≥1280px): takes column space next to the conversation.         */
/*  • overlay (<1280px): slides in over the conversation with a backdrop.     */
/* The mode swap auto-syncs `railOpen` to each mode's sensible default so a   */
/* resize doesn't leave the user looking at a giant fullscreen overlay.       */
/* -------------------------------------------------------------------------- */

interface RightRailProps {
  open: boolean;
  mode: RailMode;
  onClose: () => void;
}

export function RightRail({ open, mode, onClose }: RightRailProps) {
  const [tab, setTab] = useState<RailTab>("todo");

  if (mode === "overlay") {
    return (
      <>
        <button
          type="button"
          aria-label="Close panel"
          tabIndex={open ? 0 : -1}
          onClick={onClose}
          className={cn(
            "fixed inset-0 z-40 bg-vs-background/40 backdrop-blur-[2px]",
            "transition-opacity duration-200",
            open ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        />
        <aside
          aria-label="Today"
          aria-hidden={!open}
          className={cn(
            "fixed top-0 right-0 bottom-0 z-50 w-[340px] max-w-[88vw]",
            "border-l border-vs-bg-3/60 bg-vs-bg-1",
            "flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.18)]",
            "transition-transform duration-200 ease-out",
            "overflow-hidden",
            open ? "translate-x-0" : "translate-x-full",
          )}
        >
          <RailContent tab={tab} onTabChange={setTab} onClose={onClose} showClose />
        </aside>
      </>
    );
  }

  return (
    <aside
      aria-label="Today"
      className={cn(
        "shrink-0 h-full",
        "rounded-2xl bg-vs-bg-1",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.04)]",
        "transition-[width] duration-200 ease-out overflow-hidden",
        open ? "w-[340px]" : "w-0",
      )}
    >
      <div className="relative h-full w-[340px] flex flex-col">
        <RailContent tab={tab} onTabChange={setTab} />
      </div>
    </aside>
  );
}
