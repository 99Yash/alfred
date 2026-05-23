import { CalendarClock, ListChecks, Mail, X } from "lucide-react";
import type { ReactNode } from "react";
import { VsSegmented } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import type { RailTab } from "./helpers";
import { InboxFeed } from "./inbox-feed";
import { MeetingsFeed } from "./meetings-feed";
import { RailAtmosphere } from "./rail-atmosphere";
import { RailFooter } from "./rail-footer";
import { RailSlot } from "./rail-slot";
import { TodoFeed } from "./todo-feed";
import { WeatherChip } from "./weather-chip";

const RAIL_TABS: ReadonlyArray<{ value: RailTab; label: string; icon: ReactNode }> = [
  { value: "todo", label: "To do", icon: <ListChecks size={12} /> },
  { value: "inbox", label: "Inbox", icon: <Mail size={12} /> },
  { value: "meetings", label: "Up next", icon: <CalendarClock size={12} /> },
];

export function RailContent({
  tab,
  onTabChange,
  onClose,
  showClose = false,
}: {
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  onClose?: () => void;
  showClose?: boolean;
}) {
  return (
    <>
      <RailAtmosphere />

      <div className="relative z-10 flex h-full min-h-0 flex-col">
        {/* Header — greeting on the left, weather chip on the right. The
         * weather chip is the dimension-style atmospheric touch: a soft
         * surface plate floating above the rail's radial glow. */}
        <div className="px-4 pt-5 pb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium tracking-tight text-vs-fg-4">
              Good morning
            </div>
            <div className="mt-1 text-[11.5px] uppercase tracking-tight font-medium text-vs-fg-2">
              Friday · May 23
            </div>
          </div>
          <div className="flex items-start gap-1.5 shrink-0">
            <WeatherChip />
            {showClose ? (
              <button
                type="button"
                aria-label="Close panel"
                onClick={onClose}
                className={cn(
                  "size-7 inline-flex items-center justify-center rounded-lg",
                  "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4 transition-colors vs-press",
                  "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
                )}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="px-4 pb-3">
          <VsSegmented<RailTab>
            value={tab}
            onValueChange={onTabChange}
            items={RAIL_TABS}
            label="Today filter"
          />
        </div>

        {/* Stacked feeds — all three render in the same grid cell so the
         * outgoing feed crossfades + lifts while the new feed settles in.
         * Same pattern as `HeroShowcase`'s `Slot`. The scroll container's
         * height is the MAX of all feeds, so a tab swap never re-flows
         * the rail. */}
        <div
          className={cn(
            "relative flex-1 min-h-0 overflow-y-auto vs-scrollbar px-3 pb-3",
            "[scrollbar-width:thin]",
          )}
        >
          <div className="relative grid">
            <RailSlot active={tab === "todo"}>
              <TodoFeed />
            </RailSlot>
            <RailSlot active={tab === "inbox"}>
              <InboxFeed />
            </RailSlot>
            <RailSlot active={tab === "meetings"}>
              <MeetingsFeed />
            </RailSlot>
          </div>
        </div>

        <RailFooter />
      </div>
    </>
  );
}
