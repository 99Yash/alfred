import { ListChecks, X } from "lucide-react";
import type { ReactNode } from "react";
import { WeatherVideoSurface } from "~/components/weather-video-surface";
import { VsSegmented } from "~/components/ui/visitors";
import { useWeather } from "~/hooks/use-weather";
import { authClient } from "~/lib/auth-client";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import type { InboxItem, MeetingItem, RailTab, TodoItem } from "./helpers";
import { InboxFeed } from "./inbox-feed";
import { MeetingsFeed, type MeetingLookaheadItem } from "./meetings-feed";
import { RailFooter } from "./rail-footer";
import { RailSlot } from "./rail-slot";
import { TodoFeed, type SuggestionInput } from "./todo-feed";
import { WeatherChip } from "./weather-chip";

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

export interface RailBriefingSummary {
  /** Composed-briefing row id; reserved for a future "view briefing" surface. */
  id: string;
  /** e.g. `"morning"` / `"evening"`. */
  slot: string;
  /** Local-date the briefing covers (YYYY-MM-DD). */
  briefingDate: string;
  /** ISO timestamp when the briefing was composed. */
  runAt: string;
  subject: string | null;
}

/**
 * Server-driven pagination for the rail Inbox tab. When present, `InboxFeed`
 * surfaces ← → controls and the chat shell owns the page index; when absent
 * (preview route, fixtures), the feed renders without pagination.
 */
export interface InboxPagination {
  pageIndex: number;
  pageCount: number;
  total: number;
  isLoading: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export interface RailData {
  todos: ReadonlyArray<TodoItem>;
  todoSuggestions?: ReadonlyArray<SuggestionInput>;
  /** Check/uncheck a todo (ADR-0050). `done` is the row's current state. */
  onToggleTodo?: (id: string, done: boolean) => void;
  /** Add a user-authored todo from the rail's add row. */
  onCreateTodo?: (title: string) => void;
  /** Accept a suggestion (`suggested → open`). */
  onPromoteSuggestion?: (id: string) => void;
  inbox: ReadonlyArray<InboxItem>;
  /** Optional pagination state for the inbox tab. */
  inboxPagination?: InboxPagination;
  /** Document id of the email currently expanded in the rail reader, if any. */
  selectedInboxId?: string | null;
  /** Open the rail's single-email reader for `documentId`. */
  onOpenInbox?: (documentId: string) => void;
  /** Close the rail's single-email reader and return to the list view. */
  onCloseInbox?: () => void;
  /**
   * Bulk "Mark all read" handler. The InboxFeed calls it with the
   * currently-visible *unread* ids; the parent chat shell wires this
   * to `useMarkInboxRead()`. Optional — the preview route omits it, in
   * which case the button is a no-op (and we hide it).
   */
  onMarkInboxRead?: (documentIds: ReadonlyArray<string>) => void;
  /** True while a mark-read mutation is in flight — disables the button. */
  markInboxReadPending?: boolean;
  meetings: ReadonlyArray<MeetingItem>;
  meetingLookahead?: ReadonlyArray<MeetingLookaheadItem>;
  /**
   * Whether the user has actually connected Google Calendar. Lets the
   * meetings empty state distinguish "connect Calendar" from "Calendar
   * connected, day is clear" — both render zero items.
   */
  calendarConnected?: boolean;
  /** Latest composed briefing for the user, or null if none has run yet. */
  latestBriefing?: RailBriefingSummary | null;
}

export const EMPTY_RAIL_DATA: RailData = {
  todos: [],
  inbox: [],
  meetings: [],
  calendarConnected: false,
  latestBriefing: null,
};

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
  return (
    <>
      {/* Full-bleed condition-aware video, exactly as the styleguide
       * QuickAccessRail. Two stacked gradient scrims add legibility for
       * the rail content on top: a bottom-fading dark mask (so the
       * Morning briefing footer reads white-on-black) and a soft top
       * lift (so the header text doesn't blend into the lighter top of
       * the sky video). */}
      <WeatherVideoSurface condition={weather?.condition} isDay={weather?.isDay} />
      {/* Same legibility stack as `quick-access-rail.tsx`: a soft
       * sky-to-night ramp lets the upper video still read while the
       * lower 30% darkens enough for the feed to sit on something
       * readable. The thin top hairlight lifts the rail away from the
       * page chrome. */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.10),rgba(0,0,0,0.08)_28%,rgba(7,17,31,0.70)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.24),transparent)]" />

      <div className="relative z-10 flex h-full min-h-0 flex-col text-white">
        {/* Header — greeting on the left, weather chip on the right. The
         * weather chip is the dimension-style atmospheric touch: a soft
         * surface plate floating above the rail's radial glow. */}
        <div className="px-4 pt-5 pb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium tracking-tight text-white">
              {greeting(now)}
              {firstName(session?.user) ? `, ${firstName(session?.user)}` : ""}
            </div>
            <div className="mt-1 text-[11.5px] uppercase tracking-tight font-medium text-white/60 mix-blend-plus-lighter">
              {formatRailDate(now)}
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
                  "text-white/70 hover:bg-white/[0.07] hover:text-white transition-colors vs-press",
                  "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
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
            variant="glass"
          />
        </div>

        {/* Stacked feeds — all three render in the same grid cell so the
         * outgoing feed crossfades + lifts while the new feed settles in.
         * Same pattern as `HeroShowcase`'s `Slot`. The scroll container's
         * height is the MAX of all feeds, so a tab swap never re-flows
         * the rail. */}
        <div className="relative flex-1 min-h-0 overflow-y-auto px-3 pb-3">
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
                onCreateTodo={data.onCreateTodo}
                onPromoteSuggestion={data.onPromoteSuggestion}
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

        <RailFooter latestBriefing={data.latestBriefing ?? null} />
      </div>
    </>
  );
}

/* ---- helpers ---- */

interface SessionUser {
  name?: string | null;
  email?: string | null;
}

function firstName(user: SessionUser | null | undefined): string {
  if (!user) return "";
  if (user.name && user.name.trim()) {
    const part = user.name.trim().split(/\s+/)[0] ?? "";
    return part.charAt(0).toUpperCase() + part.slice(1);
  }
  return "";
}

function greeting(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

function formatRailDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const month = date.toLocaleDateString(undefined, { month: "short" });
  return `${weekday} · ${month} ${date.getDate()}`;
}
