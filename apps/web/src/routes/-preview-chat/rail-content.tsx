import { ListChecks, X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { WeatherVideoSurface } from "~/components/weather-video-surface";
import { AppSegmented } from "~/components/ui/v2";
import { useWeather } from "~/hooks/use-weather";
import { authClient } from "~/lib/auth/auth-client";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { firstName, greeting } from "~/lib/user-display";
import { cn } from "~/lib/utils";
import type { RailTab } from "./helpers";
import { InboxFeed } from "./inbox-feed";
import { MeetingsFeed } from "./meetings-feed";
import type { RailData } from "./rail-data";
import { RailFooter } from "./rail-footer";
import { RailSlot } from "./rail-slot";
import { TodoFeed } from "./todo-feed";
import { WeatherHero } from "./weather-hero";

const RAIL_TABS: ReadonlyArray<{ value: RailTab; label: string; icon: ReactNode }> = [
  { value: "todo", label: "To do", icon: <ListChecks size={12} /> },
  // Inbox + Up next are both source-backed (Gmail / Google Calendar). Their
  // tab glyphs mirror the brand icons in `ConnectToolsRow` so a glance
  // tells the user which integration the tab is reading from.
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
  onClose?: () => void;
  showClose?: boolean;
  data: RailData;
}) {
  const { data: session } = authClient.useSession();
  const { data: weather } = useWeather();
  const now = new Date();
  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  // CSS can't interpolate between in-flow and `absolute`, so on a tab
  // switch the grid row snaps to the incoming feed's height while the
  // 300ms crossfade is still running. If the outgoing feed was scrolled,
  // the browser clamps scrollTop to an arbitrary offset in that same
  // frame. Reset to the top before paint (layout effect) so the first
  // painted frame of the crossfade is always the coherent
  // top-of-old-feed → top-of-new-feed view, never a clamped mid-scroll.
  useLayoutEffect(() => {
    if (feedScrollRef.current) feedScrollRef.current.scrollTop = 0;
  }, [tab]);
  return (
    <>
      {/* Full-bleed condition-aware video behind the rail content. */}
      <WeatherVideoSurface condition={weather?.condition} isDay={weather?.isDay} />
      {/* Legibility stack — both scrims are DARK, because the rail content
       * is white. A neutral sky-to-night ramp darkens the lower body so the
       * feed and footer read, and a top vignette guarantees the header text
       * clears contrast on every condition.
       *
       * The header scrim is the load-bearing one: the sky videos are bright
       * at the top (rainy/cloudy ~170/255, and thunderstorm flashes blow out
       * to ~255), so a white text header floated on the raw frame. A black
       * top gradient pulls even a lightning flash under the ~118/255 white-on-
       * dark AA threshold. (The old stack lifted the top with WHITE, which
       * did the opposite — it washed the header out.) Apple Weather / the iOS
       * lock screen treat photo backdrops the same way. */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.08)_28%,rgba(7,17,31,0.70)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.55),rgba(0,0,0,0.42)_38%,rgba(0,0,0,0.16)_72%,transparent)]" />

      <div className="relative z-10 flex h-full min-h-0 flex-col text-white">
        {/* Header — "hero temperature" framing. The greeting demotes to a
         * quiet top line; the weather hero (large temp + condition icon +
         * hairline + caption) is the focal block; the date closes it as a
         * second quiet caption. Each row fades up in sequence on entrance
         * (delays climb down the block) so the header reads as one settling
         * gesture rather than four rows snapping in at once. */}
        <div className="px-4 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="animate-rail-head min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight text-white/75 mix-blend-plus-lighter">
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
          <div className="animate-rail-head mt-2 text-xs tracking-tight text-white/45 mix-blend-plus-lighter [animation-delay:210ms]">
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

        {/* Stacked feeds — all three render in the same grid cell so the
         * outgoing feed crossfades + lifts while the new feed settles in.
         * Same pattern as `HeroShowcase`'s `Slot`. Only the active feed
         * is in flow (inactive slots overlay absolutely — see `RailSlot`),
         * so the scrollable height always tracks the visible feed. */}
        <div
          ref={feedScrollRef}
          className="scroll-stable relative min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        >
          {/* Single-column track with `minmax(0, 1fr)` clamps every stacked
           * feed to the rail's width — otherwise the grid auto-sizes to its
           * widest child (the inbox rows), `truncate` stops working, and
           * narrower feeds like the to-do empty hint run past the rail's
           * visible edge. */}
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
