import { ListChecks, X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { WeatherVideoSurface } from "~/components/weather-video-surface";
import { AppSegmented } from "~/components/ui/v2";
import { useWeather } from "~/hooks/use-weather";
import { authClient } from "~/lib/auth/auth-client";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { firstName, greeting } from "~/lib/user-display";
import { cn } from "~/lib/utils";
import type { RailTab } from "./models";
import { InboxFeed } from "./inbox-feed";
import { MeetingsFeed } from "./meetings-feed";
import type { RailData } from "./rail-data";
import { RailFooter } from "./rail-footer";
import { RailSlot } from "./rail-slot";
import { TodoFeed } from "./todo-feed";
import { WeatherHero } from "./weather-hero";

const RAIL_TABS: ReadonlyArray<{ value: RailTab; label: string; icon: ReactNode }> = [
  { value: "todo", label: "To do", icon: <ListChecks size={12} /> },
  // Brand glyphs show which integration each tab reads.
  { value: "inbox", label: "Inbox", icon: <IntegrationGlyph brand="gmail" size={12} /> },
  {
    value: "meetings",
    label: "Up next",
    icon: <IntegrationGlyph brand="google_calendar" size={12} />,
  },
];

export function RailContent({
  tab,
  onTabChange,
  onClose,
  showClose = false,
  data,
}: {
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  onClose?: (() => void) | undefined;
  showClose?: boolean | undefined;
  data: RailData;
}) {
  const { data: session } = authClient.useSession();
  const { data: weather } = useWeather();
  const now = new Date();
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  // On a tab switch the grid row snaps height mid-crossfade and the browser clamps scrollTop.
  // Reset to the top before paint so the crossfade starts clean.
  useLayoutEffect(() => {
    if (feedScrollRef.current) feedScrollRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <>
      {/* Weather video behind the rail. */}
      <WeatherVideoSurface condition={weather?.condition} isDay={weather?.isDay} />
      {/* Dark scrims for white text. The top one matters most: the sky videos are bright
       * there, and lightning flashes reach ~255/255. */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.08)_28%,rgba(7,17,31,0.70)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.55),rgba(0,0,0,0.42)_38%,rgba(0,0,0,0.16)_72%,transparent)]" />

      <div className="relative z-10 flex h-full min-h-0 flex-col text-white">
        {/* Header rows fade up in sequence on entrance. */}
        <div className="px-4 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="animate-rail-head min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-white/75 mix-blend-plus-lighter">
              {greeting(now)}
              {firstName(session?.user) ? `, ${firstName(session?.user)}` : ""}
            </div>
            {showClose ? (
              <button
                type="button"
                aria-label="Close panel"
                onClick={onClose}
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg",
                  "app-press text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white",
                  "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                )}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          <WeatherHero />
          <div className="animate-rail-head mt-2 text-xs text-white/55 mix-blend-plus-lighter [animation-delay:210ms]">
            {formatRailDate(now)}
          </div>
        </div>

        <div className="px-4 pb-3">
          <AppSegmented<RailTab>
            value={tab}
            onValueChange={onTabChange}
            items={RAIL_TABS}
            label="Today filter"
            variant="glass"
          />
        </div>

        {/* All feeds share one grid cell so they crossfade. Only the active one is in flow (see `RailSlot`). */}
        <div
          ref={feedScrollRef}
          className="scroll-stable relative min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        >
          {/* `minmax(0, 1fr)` clamps feeds to the rail width; else `truncate` fails. */}
          <div className="relative grid grid-cols-[minmax(0,1fr)]">
            <RailSlot active={tab === "todo"}>
              <TodoFeed
                items={data.todos}
                suggestions={data.todoSuggestions}
                onToggleTodo={data.onToggleTodo}
                onClearTodo={data.onClearTodo}
                onCreateTodo={data.onCreateTodo}
                onCompleteSuggestion={data.onCompleteSuggestion}
                onPromoteSuggestion={data.onPromoteSuggestion}
                onDismissSuggestion={data.onDismissSuggestion}
              />
            </RailSlot>
            <RailSlot active={tab === "inbox"}>
              <InboxFeed
                items={data.inbox}
                pagination={data.inboxPagination}
                selectedId={data.selectedInboxId ?? null}
                onOpen={data.onOpenInbox}
                onClose={data.onCloseInbox}
                onMarkRead={data.onMarkInboxRead}
                markReadPending={data.markInboxReadPending}
                triageTagsByThreadId={data.triageTagsByThreadId}
                onOverrideTag={data.onOverrideTriageTag}
              />
            </RailSlot>
            <RailSlot active={tab === "meetings"}>
              <MeetingsFeed
                items={data.meetings}
                lookahead={data.meetingLookahead}
                calendarConnected={data.calendarConnected ?? false}
              />
            </RailSlot>
          </div>
        </div>

        <RailFooter
          latestBriefing={data.latestBriefing ?? null}
          onGenerate={data.onGenerateBriefing}
          pending={data.briefingPending ?? false}
        />
      </div>
    </>
  );
}

/* ---- helpers ---- */

function formatRailDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "short" });

  return `${weekday}, ${month} ${date.getDate()}`;
}
